import config from '../../config';
import * as customerTierService from '../customer-tier-service/customer-tier-service';
import Project from '../../models/project.model';
import type { IProjectDoc } from '../../models/project.model';
import User from '../../models/user.model';
import type { IUserDoc } from '../../models/user.model';
import CollaboratorRole from '../../models/collaborator-role.model';
import analytics from '../analytics/analytics';
import logger from '../../services/logger';
import Stripe from 'stripe';

const stripe = new Stripe(config.stripe!.secretKey, { apiVersion: '2020-08-27' });

export async function cancelSubscription({ project }: { project: IProjectDoc }): Promise<IProjectDoc | null> {
    const subscriptionId = project.subscription.id;

    if (!subscriptionId) {
        throw new Error('Project does not have an associated subscription');
    }

    await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true
    });

    return Project.cancelSubscription(project.id!, { skipEmail: true });
}

export async function createCheckoutSessionForChangingPaymentMethod({
    cancelUrl,
    project,
    successUrl,
    user
}: {
    cancelUrl: string;
    project: IProjectDoc;
    successUrl: string;
    user: IUserDoc;
}): Promise<Stripe.Response<Stripe.Checkout.Session>> {
    const subscriptionId = project.subscription.id;

    if (!subscriptionId) {
        throw new Error('Project does not have an associated subscription');
    }

    const checkoutData: Stripe.Checkout.SessionCreateParams = {
        payment_method_types: ['card'],
        success_url: successUrl,
        cancel_url: cancelUrl,
        customer: user.stripeCustomerId,
        mode: 'setup',
        setup_intent_data: {
            metadata: {
                customer_id: user.stripeCustomerId ?? null,
                subscription_id: subscriptionId
            }
        }
    };

    return stripe.checkout.sessions.create(checkoutData);
}

function calculateProjectQuantity(project: IProjectDoc, tierId: string): number {
    switch (customerTierService.getTierPricingMode(tierId)) {
        case 'FIXED_COST':
            return 1;
        case 'PER_CONTRIBUTOR': {
            return project.subscription.contributorCount;
        }
    }
}

export async function createCheckoutSessionForNewSubscription({
    cancelUrl,
    forceNewCustomer,
    planId,
    project,
    successUrl,
    tierId,
    user
}: {
    cancelUrl: string;
    forceNewCustomer?: boolean;
    planId?: string;
    project: IProjectDoc;
    successUrl: string;
    tierId: string;
    user?: IUserDoc;
}): Promise<Stripe.Response<Stripe.Checkout.Session>> {
    const tier = customerTierService.getById(tierId);

    if (!tier) {
        throw new Error('Invalid tier ID');
    }

    const stripePriceId = planId ? `price_${planId}` : customerTierService.getTierDefaultPlan(tierId);
    const quantity = calculateProjectQuantity(project, tierId);
    const checkoutData: Stripe.Checkout.SessionCreateParams = {
        payment_method_types: ['card'],
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: project.id,
        subscription_data: {
            metadata: {
                projectId: project.id!
            }
        },
        line_items: [{ price: stripePriceId, quantity }],
        mode: 'subscription',
        allow_promotion_codes: true,
        billing_address_collection: 'required'
    };

    if (user) {
        // If there isn't a Stripe customer ID associated with the user,
        // we create one.
        if (forceNewCustomer || !user.stripeCustomerId) {
            const stripeCustomer = await stripe.customers.create({
                email: user.email,
                metadata: {
                    userId: user.id!
                }
            });
            await user.setStripeCustomerId(stripeCustomer.id);
        }
        checkoutData.customer = user.stripeCustomerId;
    }

    return stripe.checkout.sessions.create(checkoutData);
}

function createEventFromWebhook({ requestBody, signature }: { requestBody: string; signature: string }) {
    const signingSecret = process.env.STRIPE_WEBHOOK_SECRET || config.stripe!.webhookSigningSecret;
    return stripe.webhooks.constructEvent(requestBody, signature, signingSecret);
}

export interface SubscriptionDetails {
    tier?: customerTierService.CustomerTier & { id: string };
    startDate: number;
    paymentMethod: {
        type: Stripe.PaymentMethod.Type;
        card: {
            brand?: string;
            last4?: string;
        };
    } | null;
    scheduledForCancellation?: boolean;
    cancelAt?: number;
    canceledAt?: number;
}

export async function getSubscription(project: IProjectDoc): Promise<SubscriptionDetails | null> {
    const subscriptionId = project.subscription.id;

    if (!subscriptionId) {
        return null;
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const productId = subscription.items.data[0]?.plan.product as string;
    const tier = customerTierService.getTierByProductId(productId);
    const data: SubscriptionDetails = {
        tier,
        startDate: subscription.created * 1000,
        paymentMethod: null
    };

    if (subscription.cancel_at) {
        data.scheduledForCancellation = true;
        data.cancelAt = subscription.cancel_at * 1000;
        data.canceledAt = subscription.canceled_at! * 1000;
    }

    if (subscription.default_payment_method) {
        const paymentMethod = await stripe.paymentMethods.retrieve(subscription.default_payment_method as string);

        data.paymentMethod = {
            type: paymentMethod.type,
            card: {
                brand: paymentMethod.card?.brand,
                last4: paymentMethod.card?.last4
            }
        };
    }

    return data;
}

async function syncWithStripe(project: IProjectDoc) {
    const subscriptionId = project.subscription.id;
    if (!subscriptionId) {
        return project;
    }
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const productId = subscription.items?.data?.[0]?.price?.product as string | undefined;
    return Project.updateSubscription(project.id!, {
        endOfBillingCycle: new Date(subscription.current_period_end * 1000),
        scheduledForCancellation: !!subscription.cancel_at,
        tierId: productId ? customerTierService.getTierByProductId(productId)?.id : undefined
    });
}

// (!) Ensure the Stripe webhook is dispatching the following events:
//
// - customer.subscription.created
// - checkout.session.completed
// - customer.subscription.deleted
// - customer.subscription.updated
// - invoice.paid
export async function handleWebhookEvent({ body, headers }: { body: Buffer | string; headers: Record<string, string> }): Promise<void> {
    let event;

    try {
        event = createEventFromWebhook({
            requestBody: body.toString('utf8'),
            signature: headers['stripe-signature']!
        });
    } catch (error) {
        throw new Error('Invalid webhook signature');
    }

    if (event.type === 'customer.subscription.created') {
        const subscription = event.data.object as Stripe.Subscription;
        const projectId = subscription.metadata.projectId;
        const subscriptionId = subscription.id;
        const customerId = subscription.customer as string;

        if (!projectId || !subscriptionId) {
            throw new Error('Project ID or Subscription ID missing from the request');
        }

        await registerSubscription({ customerId, projectId, subscriptionId });
        return;
    }

    if (event.type === 'checkout.session.completed' && (event.data.object as Stripe.Checkout.Session).mode === 'setup') {
        const session = event.data.object as Stripe.Checkout.Session;
        const setupIntentId = session.setup_intent as string | null;

        if (setupIntentId) {
            await updatePaymentMethod({ setupIntentId });
        }
        return;
    }

    if (event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object as Stripe.Subscription;
        const projectId = subscription.metadata.projectId;

        if (!projectId) {
            throw new Error('Project ID missing from the request');
        }

        await Project.cancelSubscription(projectId, { immediate: true });
        return;
    }

    if (event.type === 'customer.subscription.updated') {
        const subscription = event.data.object as Stripe.Subscription;
        const ignoredSubscription = subscription.metadata.ignoredSubscription === 'true';
        if (ignoredSubscription) {
            logger.info(`Ignoring Stripe webhook from ignored subscription ${subscription.id}`);
            return;
        }
        const projectId = subscription.metadata.projectId;
        if (!projectId) {
            throw new Error('Project ID missing from the request');
        }
        const isCancelled = !(event.data.previous_attributes as Partial<Stripe.Subscription>).cancel_at && subscription.cancel_at;
        if (isCancelled) {
            await Project.cancelSubscription(projectId);
            return;
        }
        await syncWithStripe((await Project.findById(projectId))!);
        return;
    }

    if (event.type === 'invoice.paid') {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = invoice.subscription;

        if (!subscriptionId) {
            return;
        }

        const subscription = await stripe.subscriptions.retrieve(subscriptionId as string);
        const projectId = subscription.metadata.projectId;
        const periodEnd = invoice.lines.data[0]!.period.end;

        if (projectId) {
            await Project.updateSubscription(projectId, {
                endOfBillingCycle: new Date(periodEnd * 1000)
            });
        }
        return;
    }
}

async function registerSubscription({
    customerId,
    projectId,
    subscriptionId
}: {
    customerId: string;
    projectId: string;
    subscriptionId: string;
}): Promise<void> {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const productId = subscription.items.data[0]!.plan.product;
    const tierId = Object.keys(config.customerTiers).find((tierId) => customerTierService.getTierStripeProductId(tierId) === productId);

    if (!tierId) {
        return;
    }

    // non blocking request to send analytics in the background
    (async () => {
        try {
            const user = await User.findUserByCustomerId(customerId);
            const userType =
                user && (await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.BILLING))
                    ? 'user'
                    : 'other-user';
            analytics.track('Subscription Created', { projectId, tierId, userType }, user || { id: 'unknown' });
        } catch (e) {
            logger.error('Error preparing analytics data for created subscription', e);
        }
    })();

    await Project.startSubscription(projectId, {
        subscriptionId,
        tierId
    });
}

async function updatePaymentMethod({ setupIntentId }: { setupIntentId: string }): Promise<void> {
    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
    const setupIntentPaymentMethodId = setupIntent.payment_method;
    const setupIntentSubscriptionId = setupIntent.metadata?.subscription_id;

    if (!setupIntentPaymentMethodId || !setupIntentSubscriptionId) {
        throw new Error('Event is missing SetupIntent parameters');
    }

    await stripe.subscriptions.update(setupIntentSubscriptionId, {
        default_payment_method: setupIntentPaymentMethodId as string
    });
}

export async function updateTier({ planId, project, tierId }: { planId: string; project: IProjectDoc; tierId: string }): Promise<void> {
    const currentTierId = project.subscription.safeTierId;

    if (currentTierId === tierId && !project.subscription.scheduledForCancellation) {
        return;
    }

    const currentTier = customerTierService.getById(currentTierId);
    const newTier = customerTierService.getById(tierId);

    if (!currentTier || !newTier) {
        throw new Error('Invalid customer tier');
    }

    const stripePriceId = planId ? `price_${planId}` : customerTierService.getTierDefaultPlan(tierId);
    const subscriptionId = project.subscription.id;
    if (!subscriptionId) {
        throw new Error('Project does not have an associated subscription');
    }
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const quantity = calculateProjectQuantity(project, tierId);

    await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: false,
        items: [{ id: subscription.items.data[0]!.id, price: stripePriceId, quantity }]
    });
    await syncWithStripe(project);
}

export async function updateProjectQuantity(project: IProjectDoc): Promise<void> {
    const tierId = project.subscription.safeTierId;
    const subscriptionId = project.subscription.id;
    if (!subscriptionId) {
        throw new Error('Project does not have an associated subscription');
    }
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const quantity = calculateProjectQuantity(project, tierId);

    if (quantity !== subscription.items.data[0]!.quantity) {
        await stripe.subscriptions.update(subscriptionId, {
            items: [{ id: subscription.items.data[0]!.id, quantity }]
        });
    }
}
