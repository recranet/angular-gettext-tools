'use strict';

const po = require('pofile');

const formats = {
    javascript: {
        addLocale: function (locale, strings) {
            return '    gettextCatalog.setStrings(\'' + locale + '\', ' + JSON.stringify(strings) + ');\n';
        },
        format: function (locales, options) {
            let angular = 'angular';
            if (options.browserify) {
                angular = 'require(\'angular\')';
            }
            let module = angular + '.module(\'' + options.module + '\')' +
                '.run([\'gettextCatalog\', function (gettextCatalog) {\n' +
                    '/* jshint -W100 */\n' +
                    locales.join('') +
                    '/* jshint +W100 */\n';
            if (options.defaultLanguage) {
                module += 'gettextCatalog.currentLanguage = \'' + options.defaultLanguage + '\';\n';
            }
            module += '}]);';

            if (options.requirejs) {
                return 'define([\'angular\', \'' + options.modulePath + '\'], function (angular) {\n' + module + '\n});';
            }

            return module;
        }
    },
    json: {
        addLocale: function (locale, strings) {
            return {
                name: locale,
                strings: strings
            };
        },
        format: function (locales, options) {
            const result = {};
            locales.forEach(function (locale) {
                if (!result[locale.name]) {
                    result[locale.name] = {};
                }
                Object.assign(result[locale.name], locale.strings);
            });
            return JSON.stringify(result);
        }
    }
};

const noContext = '$$noContext';

class Compiler {
    constructor(options) {
        this.options = Object.assign({
            format: 'javascript',
            ignoreFuzzyString: true,
            module: 'gettext'
        }, options);
    }

    static hasFormat(format) {
        return Object.prototype.hasOwnProperty.call(formats, format);
    }

    convertPo(inputs) {
        const format = formats[this.options.format];
        const ignoreFuzzyString = this.options.ignoreFuzzyString;
        const locales = [];

        inputs.forEach(function (input) {
            const catalog = po.parse(input);

            if (!catalog.headers.Language) {
                throw new Error('No Language header found!');
            }

            const strings = {};
            for (let i = 0; i < catalog.items.length; i++) {
                const item  = catalog.items[i];
                const ctx   = item.msgctxt || noContext;
                let msgid = item.msgid;

                for (const unconvertedEntity in Compiler.browserConvertedHTMLEntities) {
                    const convertedEntity = Compiler.browserConvertedHTMLEntities[unconvertedEntity];
                    const unconvertedEntityPattern = new RegExp('&' + unconvertedEntity + ';?', 'g');
                    msgid = msgid.replace(unconvertedEntityPattern, convertedEntity);
                }

                const nonEmptyUpToDateStr = item.msgstr[0].length > 0 && !item.obsolete;
                const useNonFuzzyStrOnly = ignoreFuzzyString && !item.flags.fuzzy;

                if (nonEmptyUpToDateStr && (useNonFuzzyStrOnly || !ignoreFuzzyString)) {
                    if (!strings[msgid]) {
                        strings[msgid] = {};
                    }

                    // Add array for plural, single string for singular.
                    strings[msgid][ctx] = item.msgstr.length === 1 ? item.msgstr[0] : item.msgstr;
                }
            }

            // Strip context from strings that have no context.
            for (const key in strings) {
                if (Object.keys(strings[key]).length === 1 && strings[key][noContext]) {
                    strings[key] = strings[key][noContext];
                }
            }

            locales.push(format.addLocale(catalog.headers.Language, strings));
        });

        return format.format(locales, this.options);
    }
}

Compiler.browserConvertedHTMLEntities = {
    'hellip': '…',
    'cent': '¢',
    'pound': '£',
    'euro': '€',
    'laquo': '«',
    'raquo': '»',
    'rsaquo': '›',
    'lsaquo': '‹',
    'copy': '©',
    'reg': '®',
    'trade': '™',
    'sect': '§',
    'deg': '°',
    'plusmn': '±',
    'para': '¶',
    'middot': '·',
    'ndash': '–',
    'mdash': '—',
    'lsquo': '‘',
    'rsquo': '’',
    'sbquo': '‚',
    'ldquo': '“',
    'rdquo': '”',
    'bdquo': '„',
    'dagger': '†',
    'Dagger': '‡',
    'bull': '•',
    'prime': '′',
    'Prime': '″',
    'asymp': '≈',
    'ne': '≠',
    'le': '≤',
    'ge': '≥',
    'sup2': '²',
    'sup3': '³',
    'frac12': '½',
    'frac14': '¼',
    'frac13': '⅓',
    'frac34': '¾'
};

module.exports = Compiler;
