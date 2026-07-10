'use strict';

const htmlparser2 = require('htmlparser2');
const DomUtils = htmlparser2.DomUtils;
const Po = require('pofile');
const babelParser = require('@babel/parser');

const escapeRegex = /[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g;
const noContext = '$$noContext';

function mkAttrRegex(startDelim, endDelim, attribute) {
    let start = startDelim.replace(escapeRegex, '\\$&');
    const end = endDelim.replace(escapeRegex, '\\$&');

    if (start === '' && end === '') {
        start = '^';
    } else {
        // match optional :: (Angular 1.3's bind once syntax) without capturing
        start += '(?:\\s*\\:\\:\\s*)?';
    }

    if (typeof attribute !== 'string' || attribute.length === 0) {
        attribute = 'translate';
    }

    return new RegExp(start + '\\s*(\'|"|&quot;|&#39;)(.*?)\\1\\s*\\|\\s*' + attribute + '\\s*:?\\s?(?:(\'|"|&quot;|&#39;)\\s*(.*?)\\3)?\\s*(?:' + end + '|\\|)', 'g');
}

function stringCompare(a, b) {
    return a === b ? 0 : a > b ? 1 : -1;
}

function contextCompare(a, b) {
    if (a !== null && b === null) {
        return -1;
    } else if (a === null && b !== null) {
        return 1;
    }
    return stringCompare(a, b);
}

// Binary search: returns the index of `item` in the sorted array `arr`,
// or a negative number encoding the insertion point (-(index + 1)) when absent.
function search(arr, item) {
    let low = 0;
    let high = arr.length - 1;

    while (low <= high) {
        const mid = (low + high) >>> 1;
        const cmp = stringCompare(arr[mid], item);
        if (cmp < 0) {
            low = mid + 1;
        } else if (cmp > 0) {
            high = mid - 1;
        } else {
            return mid;
        }
    }

    return -(low + 1);
}

function comments2String(comments) {
    return comments.join(', ');
}

function walkJs(node, fn, parentComment) {
    fn(node, parentComment);

    // Handle ts comments
    if (node && node.comments) {
        parentComment = node;
        parentComment.comments.reverse();
    }

    for (const key in node) {
        const obj = node[key];
        if (node && node.leadingComments) {
            parentComment = node;
        }

        if (typeof obj === 'object') {
            walkJs(obj, fn, parentComment);
        }
    }
}

function isStringLiteral(node) {
    return node.type === 'StringLiteral' || (node.type === 'Literal' && typeof node.value === 'string');
}

function getJSExpression(node) {
    let res = '';
    if (isStringLiteral(node)) {
        res = node.value;
    }

    if (node.type === 'TemplateLiteral') {
        node.quasis.forEach(function (elem) {
            res += elem.value.raw;
        });
    }

    if (node.type === 'BinaryExpression' && node.operator === '+') {
        res += getJSExpression(node.left);
        res += getJSExpression(node.right);
    }
    return res;
}

// Depth-first pre-order walk over all elements in the parsed document,
// mirroring the document order of a `$('*')` selection.
function walkElements(nodes, fn) {
    for (const node of nodes) {
        if (DomUtils.isTag(node)) {
            fn(node);
        }
        if (node.children && node.children.length) {
            walkElements(node.children, fn);
        }
    }
}

class Extractor {
    constructor(options) {
        this.options = Object.assign({
            startDelim: '{{',
            endDelim: '}}',
            markerName: 'gettext',
            markerNames: [],
            markerNamePlural: null,
            markerNamesPlural: [],
            moduleName: 'gettextCatalog',
            moduleMethodString: 'getString',
            moduleMethodPlural: 'getPlural',
            attribute: 'translate',
            attributes: [],
            filterName: null,
            lineNumbers: true,
            extensions: {
                htm: 'html',
                html: 'html',
                php: 'html',
                phtml: 'html',
                tml: 'html',
                ejs: 'html',
                erb: 'html',
                js: 'js',
                tag: 'html',
                jsp: 'html',
                ts: 'js',
                tsx: 'js',
            },
            postProcess: function (po) {}
        }, options);
        this.options.markerNames.unshift(this.options.markerName);
        if (this.options.markerNamePlural) {
            this.options.markerNamesPlural.unshift(this.options.markerNamePlural);
        }

        this.options.attributes.unshift(this.options.attribute);

        if (!this.options.filterName) {
            // If the filter name is not specified, assume the specified attribute is also the filter name
            this.options.filterName = this.options.attribute;
        }

        this.strings = {};
        this.attrRegex = mkAttrRegex(this.options.startDelim, this.options.endDelim, this.options.filterName);
        this.noDelimRegex = mkAttrRegex('', '', this.options.filterName);
    }

    static isValidStrategy(strategy) {
        return strategy === 'html' || strategy === 'js';
    }

    addString(reference, string, plural, extractedComment, context) {
        // maintain backwards compatibility
        if (typeof reference === 'string') {
            reference = { file: reference };
        }

        string = string.trim();

        if (string.length === 0) {
            return;
        }

        if (!context) {
            context = noContext;
        }

        if (!this.strings[string] || typeof this.strings[string] !== 'object') {
            this.strings[string] = {};
        }

        if (!this.strings[string][context]) {
            this.strings[string][context] = new Po.Item();
        }

        const item = this.strings[string][context];
        item.msgid = string;

        let refString = reference.file;
        if (this.options.lineNumbers && reference.location && reference.location.start) {
            const line = reference.location.start.line;
            if (line || line === 0) {
                refString += ':' + reference.location.start.line;
            }
        }
        const refIndex = search(item.references, refString);
        if (refIndex < 0) { // don't add duplicate references
            // when not found, search returns -(index_where_it_should_be + 1)
            item.references.splice(Math.abs(refIndex + 1), 0, refString);
        }

        if (context !== noContext) {
            item.msgctxt = context;
        }

        if (plural && plural !== '') {
            if (item.msgid_plural && item.msgid_plural !== plural) {
                throw new Error('Incompatible plural definitions for ' + string + ': ' + item.msgid_plural + ' / ' + plural + ' (in: ' + (item.references.join(', ')) + ')');
            }
            item.msgid_plural = plural;
            item.msgstr = ['', ''];
        }
        if (extractedComment) {
            const commentIndex = search(item.extractedComments, extractedComment);
            if (commentIndex < 0) { // don't add duplicate comments
                item.extractedComments.splice(Math.abs(commentIndex + 1), 0, extractedComment);
            }
        }
    }

    extractJs(filename, src, lineNumber) {
        // used for line number of JS in HTML <script> tags
        lineNumber = lineNumber || 0;
        const self = this;
        let syntax;
        const extension = filename.split('.').pop();
        try {
            const plugins = (extension === 'ts' || extension === 'tsx') ?
                [
                    'typescript',
                    'decorators-legacy',
                    'classProperties'
                ] :
                [
                    'jsx',
                    'objectRestSpread',
                    'decorators-legacy',
                    'classProperties',
                    'exportDefaultFrom',
                    'exportNamespaceFrom',
                    'functionBind',
                    'dynamicImport'
                ];

            if (extension === 'tsx') {
                plugins.push('jsx');
            }

            syntax = babelParser.parse(src, {
                sourceType: 'module',
                plugins: plugins
            });
        } catch (err) {
            let errMsg = 'Error parsing';
            if (filename) {
                errMsg += ' ' + filename;
            }
            if (err.lineNumber) {
                errMsg += ' at line ' + err.lineNumber;
                errMsg += ' column ' + err.column;
            }

            console.warn(errMsg);
            return;
        }

        function isGettext(node) {
            return node !== null &&
                node.type === 'CallExpression' &&
                node.callee !== null &&
                (self.options.markerNames.indexOf(node.callee.name) > -1 || (
                    node.callee.property &&
                    self.options.markerNames.indexOf(node.callee.property.name) > -1
                )) &&
                node.arguments !== null &&
                node.arguments.length;
        }

        function isGettextPlural(node) {
            return node !== null &&
                node.type === 'CallExpression' &&
                node.callee !== null &&
                (self.options.markerNamesPlural.indexOf(node.callee.name) > -1 || (
                    node.callee.property &&
                    self.options.markerNamesPlural.indexOf(node.callee.property.name) > -1
                )) &&
                node.arguments !== null &&
                node.arguments.length;
        }

        function isGetString(node) {
            return node !== null &&
                node.type === 'CallExpression' &&
                node.callee !== null &&
                node.callee.type === 'MemberExpression' &&
                node.callee.object !== null && (
                    node.callee.object.name === self.options.moduleName || (
                        // also allow gettextCatalog calls on objects like this.gettextCatalog.getString()
                        node.callee.object.property &&
                        node.callee.object.property.name === self.options.moduleName)) &&
                node.callee.property !== null &&
                node.callee.property.name === self.options.moduleMethodString &&
                node.arguments !== null &&
                node.arguments.length;
        }

        function isGetPlural(node) {
            return node !== null &&
                node.type === 'CallExpression' &&
                node.callee !== null &&
                node.callee.type === 'MemberExpression' &&
                node.callee.object !== null && (
                    node.callee.object.name === self.options.moduleName || (
                        // also allow gettextCatalog calls on objects like this.gettextCatalog.getPlural()
                        node.callee.object.property &&
                        node.callee.object.property.name === self.options.moduleName)) &&
                node.callee.property !== null &&
                node.callee.property.name === self.options.moduleMethodPlural &&
                node.arguments !== null &&
                node.arguments.length;
        }

        function isTemplateElement(node) {
            return node !== null &&
                node.type === 'TemplateElement' &&
                node.value &&
                node.value.raw;
        }

        walkJs(syntax, function (node, parentComment) {
            let str;
            let context;
            let singular;
            let plural;
            const extractedComments = [];
            const reference = {
                file: filename,
                location: (node && node.loc && node.loc.start) ? {
                    start: {
                        line: node.loc.start.line + lineNumber
                    }
                } : null
            };

            if (isGettext(node) || isGetString(node)) {
                str = getJSExpression(node.arguments[0]);
                if (node.arguments[2]) {
                    context = getJSExpression(node.arguments[2]);
                }
            } else if (isGettextPlural(node) || isGetPlural(node)) {
                singular = getJSExpression(node.arguments[1]);
                plural = getJSExpression(node.arguments[2]);
                if (node.arguments[4]) {
                    context = getJSExpression(node.arguments[4]);
                }
            } else if (isTemplateElement(node)) {
                const line = reference.location && reference.location.start.line ? reference.location.start.line - 1 : 0;
                self.extractHtml(reference.file, node.value.raw, line);
            }
            if (str || singular) {
                const leadingComments = node.leadingComments || (parentComment ? parentComment.leadingComments : []);
                if (leadingComments) {
                    leadingComments.forEach(function (comment) {
                        if (comment.value.match(/^\/ .*/)) {
                            extractedComments.push(comment.value.replace(/^\/ /, ''));
                        }
                    });
                }

                // Handle ts comments
                if (parentComment.comments) {
                    let commentFound = 0;
                    parentComment.comments.forEach(function (comment) {
                        if (comment.type === 'Line' &&
                            comment.loc.start.line === (reference.location.start.line - commentFound - 1) &&
                            comment.value.match(/^\/ .*/)) {
                            commentFound++;
                            extractedComments.push(comment.value.replace(/^\/ /, ''));
                        }
                    });
                    extractedComments.reverse();
                }

                if (str) {
                    self.addString(reference, str, plural, comments2String(extractedComments), context);
                } else if (singular) {
                    self.addString(reference, singular, plural, comments2String(extractedComments), context);
                }
            }
        });
    }

    extractHtml(filename, src, lineNumber) {
        const self = this;

        const extractHtml = function (src, lineNumber) {
            const document = htmlparser2.parseDocument(src, {
                decodeEntities: false,
                withStartIndices: true
            });

            const newlines = function (index) {
                return src.substr(0, index).match(/\n/g) || [];
            };
            const reference = function (index) {
                return {
                    file: filename,
                    location: {
                        start: {
                            line: lineNumber + newlines(index).length + 1
                        }
                    }
                };
            };

            walkElements(document.children, function (n) {
                const getAttr = function (attr) {
                    return n.attribs[attr] || n.attribs['data-' + attr];
                };
                let str = DomUtils.getInnerHTML(n, { encodeEntities: false });
                const extracted = {};
                const possibleAttributes = self.options.attributes;

                possibleAttributes.forEach(function (attr) {
                    extracted[attr] = {
                        plural: getAttr(attr + '-plural'),
                        extractedComment: getAttr(attr + '-comment'),
                        context: getAttr(attr + '-context')
                    };
                });

                if (n.name === 'script') {
                    if (n.attribs.type === 'text/ng-template') {
                        extractHtml(DomUtils.textContent(n), newlines(n.startIndex).length);
                        return;
                    }

                    // In HTML5, type defaults to text/javascript.
                    // In HTML4, it's required, so if it's not there, just assume it's JS
                    if (!n.attribs.type || n.attribs.type === 'text/javascript') {
                        self.extractJs(filename, DomUtils.textContent(n), newlines(n.startIndex).length);
                        return;
                    }
                }

                if (n.name === self.options.attribute) {
                    self.addString(reference(n.startIndex), str, extracted[self.options.attribute].plural, extracted[self.options.attribute].extractedComment, extracted[self.options.attribute].context);
                    return;
                }

                /**
                 * Extract the value, default translate filter behavior
                 * else if it is an attribute we need to get its value first
                 * @param  {String} attr Key name
                 * @param  {Node} node
                 * @return {String}
                 */
                function extractValue(attr, node) {
                    if (attr === 'translate') {
                        return DomUtils.getInnerHTML(node, { encodeEntities: false }) || getAttr(attr) || '';
                    }
                    return getAttr(attr) || DomUtils.getInnerHTML(node, { encodeEntities: false }) || '';
                }

                let matches;
                for (let attr in n.attribs) {
                    attr = attr.replace(/^data-/, '');

                    if (possibleAttributes.indexOf(attr) > -1) {
                        const attrValue = extracted[attr];
                        str = extractValue(attr, n);
                        self.addString(reference(n.startIndex), str, attrValue.plural, attrValue.extractedComment, attrValue.context);
                    } else if (matches = self.noDelimRegex.exec(getAttr(attr))) {
                        str = matches[2].replace(/\\\'/g, '\'');
                        self.addString(reference(n.startIndex), str);
                        self.noDelimRegex.lastIndex = 0;
                    }
                }
            });

            let matches;
            while (matches = self.attrRegex.exec(src)) {
                const str = matches[2].replace(/\\\'/g, '\'');
                const context = matches[4] ? matches[4].replace(/\\\'/g, '\'') : null;
                self.addString(reference(matches.index), str, null, null, context);
            }
        };

        extractHtml(src, lineNumber || 0);
    }

    isSupportedByStrategy(strategy, extension) {
        return (extension in this.options.extensions) && (this.options.extensions[extension] === strategy);
    }

    parse(filename, content) {
        const extension = filename.split('.').pop();

        if (this.isSupportedByStrategy('html', extension)) {
            this.extractHtml(filename, content);
        }
        if (this.isSupportedByStrategy('js', extension)) {
            this.extractJs(filename, content);
        }
    }

    toString() {
        const catalog = new Po();

        catalog.headers = {
            'Content-Type': 'text/plain; charset=UTF-8',
            'Content-Transfer-Encoding': '8bit',
            'Project-Id-Version': ''
        };

        const sortedItems = [];
        for (const msgstr in this.strings) {
            const msg = this.strings[msgstr];
            const contexts = Object.keys(msg);
            for (let i = 0; i < contexts.length; i++) {
                sortedItems.push([msg[contexts[i]], i]);
            }
        }

        sortedItems.sort(function (a, b) {
            return contextCompare(a[0].msgctxt, b[0].msgctxt) || stringCompare(a[0].msgid, b[0].msgid) || (a[1] - b[1]);
        });

        for (let j = 0; j < sortedItems.length; j++) {
            catalog.items.push(sortedItems[j][0]);
        }

        this.options.postProcess(catalog);

        return catalog.toString();
    }
}

Extractor.mkAttrRegex = mkAttrRegex;

module.exports = Extractor;
