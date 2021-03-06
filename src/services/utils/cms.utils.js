const path = require('path');
const _ = require('lodash');
const slugify = require('slugify');
const moment = require('moment');
const nameGenerator = require('@stackbit/artisanal-names');


const getFieldDefaultValue = type => {
    switch (type) {
    case 'string':
        return 'lorem-ipsum';
    case 'slug':
        return `${nameGenerator.generate()}-${_.random(500)}`;
    case 'url':
        return 'https://example.com';
    case 'text':
        return 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';
    case 'markdown':
        return `Etiam facilisis lacus nec pretium lobortis. Praesent dapibus justo non efficitur efficitur. Nullam viverra justo arcu, eget egestas tortor pretium id. Sed imperdiet mattis eleifend. Vivamus suscipit et neque imperdiet venenatis.
        
> Vestibulum ullamcorper risus auctor eleifend consequat.

![Placeholder Image](https://assets.stackbit.com/components/images/default/post-4.jpeg)

In malesuada sed urna eget vehicula. Donec fermentum tortor sit amet nisl elementum fringilla. Pellentesque dapibus suscipit faucibus. Nullam malesuada sed urna quis rutrum. Donec facilisis lorem id maximus mattis. Vestibulum quis elit magna. Vestibulum accumsan blandit consequat. Phasellus quis posuere quam.

Vivamus mollis in tellus ac ullamcorper. Vestibulum sit amet bibendum ipsum, vitae rutrum ex. Nullam cursus, urna et dapibus aliquam, urna leo euismod metus, eu luctus justo mi eget mauris. Proin felis leo, volutpat et purus in, lacinia luctus eros. Pellentesque lobortis massa scelerisque lorem ullamcorper, sit amet elementum nulla scelerisque. In volutpat efficitur nulla, aliquam ornare lectus ultricies ac. Mauris sagittis ornare dictum. Nulla vel felis ut purus fermentum pretium. Sed id lectus ac diam aliquet venenatis. Etiam ac auctor enim. Nunc velit mauris, viverra vel orci ut, egestas rhoncus diam. Morbi scelerisque nibh tellus, vel varius urna malesuada sed. Etiam ultricies sem consequat, posuere urna non, maximus ex. Mauris gravida diam sed augue condimentum pulvinar vel ac dui. Integer vel convallis justo.`;
    case 'richText':
        return '<h1>Lorem Ipsum</h1><p>Lorem Ipsum has been the industry\'s standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book.</p>';
    case 'enum':
        return '';
    case 'number':
        return 0;
    case 'boolean':
        return false;
    case 'date':
        // ISO 8601 - 2020-03-31
        // supproted by Contentful, Sanity and Forestry
        return (new Date()).toISOString().substring(0, 10);
    case 'datetime':
        // ISO 8601 - 2020-03-31T19:11:36.241Z
        // supproted by Contentful, Sanity and Forestry
        return (new Date()).toISOString();
    }
};

const convertValueToType = (value, type) => {
    if (type === 'number') {
        const convertedValue = _.toNumber(value);
        if (_.isNaN(convertedValue)) {
            throw new Error(`Can't convert ${value} to number`);
        }
        return convertedValue;
    } else if (['string', 'text', 'markdown', 'url'].includes(type)) {
        return String(value);
    }
    return value;
};

const getDefaultFieldsFromModel = (model, schema, objectDeepLevel = 0, {processAsset, duplicatableModels, createReferences = false} = {}) => {
    if (model.const) {
        return model.const;
    }
    if (_.has(model, 'default')) {
        return model.default;
    }
    if (model.type === 'enum' && _.get(model, 'options.length')) {
        return model.options[0];
    }
    if (model.type === 'list') {
        return [];
    }
    if (model.type === 'image' && model.required && processAsset) {
        // return empty string, AKA empty asset path
        // it will be adapted inside each CMS service differently
        return '';
    }
    if (model.type === 'reference' && model.required && createReferences && duplicatableModels.includes(model.name)) {
        // return 'new', AKA new reference field
        // it will be adapted inside each CMS service differently
        return 'new';
    }
    if (objectDeepLevel >= 0) {
        // DEPRECATION NOTICE: model.type === 'models' is deprecated and can be removed after V2 release
        if (model.type === 'models') {
            const currentModel = schema[model.models[0]];
            return getDefaultFieldsFromModel(currentModel, schema, objectDeepLevel, {processAsset, duplicatableModels, createReferences});
        }
        if (model.type === 'model') {
            // DEPRECATION NOTICE: model.model of model.type === 'model' is deprecated and can be removed after V2 release
            const currentModel = model.model ? schema[model.model] : schema[model.models[0]];
            return getDefaultFieldsFromModel(currentModel, schema, objectDeepLevel, {processAsset, duplicatableModels, createReferences});
        }
        if (['object', 'page', 'data'].includes(model.type)) {
            return _.reduce(model.fields, (acc, field) => {
                const value = getDefaultFieldsFromModel(field, schema, objectDeepLevel - 1, {processAsset, duplicatableModels, createReferences});
                if (typeof value !== 'undefined') {
                    acc[field.name] = value;
                }
                return acc;
            }, {});
        }
    }
    return getFieldDefaultValue(model.type);
};

function generateNameId(prefix) {
    return `${prefix}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Updates slug field by slugifying it (e.g. replacing spaces to minuses etc)
 * The `stackbit_url_path` field exists in pages of projects that were generated by stackbit-factory for API-based CMS.
 * This field should always hold the full URL path of the page, even when page model's urlPath consists of several
 * parts like "/posts/{slug}" (the `stackbit_url_path` is not the `slug` part).
 * When `stackbit_url_path` is present, stackbit-container sets it as `pageModel.slugField`, thus making stackbit-app
 * send user provided slug as `stackbit_url_path` field. In this case, interpolate page URL using model's `urlPath` by
 * replacing `slug` with the value of `stackbit_url_path`, and then store the final result in `stackbit_url_path`.
 * In case it's non stackbit factory created site, just sanitize slug and save it in the fields.
 *
 * @param {Object} pageModel Page model as received from client
 * @param {Object} fields User provided parameters for page creation
 */
function updateSlugField(pageModel, fields) {
    const userSlugFieldName = _.get(pageModel, 'slugField');
    if (!userSlugFieldName) {
        return fields;
    }

    const userSlug = sanitizeSlug(_.get(fields, userSlugFieldName));
    if (userSlugFieldName !== 'stackbit_url_path') {
        // slug is user defined field - just run sanitizer and save it as is
        return _.assign({}, fields, { [userSlugFieldName]: userSlug });

    }
    // in case of stackbit_url_path, use its value to interpolate url and write the result back to stackbit_url_path
    const urlPathPattern = _.get(pageModel, 'urlPath', _.get(pageModel, 'url'));
    const stackbitUrlPath = interpolatePath(urlPathPattern, { slug: userSlug });
    return _.assign({}, fields, { stackbit_url_path: stackbitUrlPath });
}

/**
 * Interpolates url or file path pattern from data.
 * If token does not exist in data returns original token.
 *
 * @example
 * interpolateFileName('posts/{slug}', { slug: 'hello' })
 * => 'posts/hello'
 * interpolateFileName('_posts/{moment_format("YYYY-MM-DD")}-{slug}.md', { slug: 'hello' })
 * => '_posts/2020-11-16-hello.md'
 *
 * @param {string} pathTemplate
 * @param {Object} data
 * @return {string}
 */
function interpolatePath(pathTemplate, data) {
    const interpolatedPath = convertToRegularTokens(pathTemplate).replace(/{(.*?)}/g, (match, tokenName) => {
        const momentFormatRe = /moment_format\(\s*(?:(?<param>.+?)\s*,\s*)?['"](?<format>[^'"]+)['"]\s*\)/;
        const momentFormatMatch = tokenName.match(momentFormatRe);
        if (momentFormatMatch) {
            const date = _.get(data, momentFormatMatch.groups.param) || new Date();
            return moment(date).format(momentFormatMatch.groups.format);
        }
        return _.get(data, tokenName, `{${tokenName}}`);
    });
    return path.normalize(interpolatedPath);
}

function sanitizeSlug(slug) {
    return slug.split('/').map(part => slugify(part, { lower: true })).join('/');
}

function convertToRegularTokens(input) {
    return input.replace(/%([^%]+)%/g, (match, tokenName) => `{${tokenName}}`);
}

module.exports = {
    getFieldDefaultValue,
    getDefaultFieldsFromModel,
    convertValueToType,
    generateNameId,
    updateSlugField,
    interpolatePath,
    sanitizeSlug,
};
