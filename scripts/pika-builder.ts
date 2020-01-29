import * as ts from 'typescript'
import * as fs from 'fs'
// @ts-ignore
import * as _removeMap from './pika-webpack-builder.js'
const removeMap: Map<string, string> = _removeMap

const preTransformTable = new Map<string, string>()
preTransformTable.set('@holoflows/kit/es', '@holoflows/kit')

// @ts-ignore
const importToken: ts.Expression = ts.createToken(ts.SyntaxKind.ImportKeyword)
export default function(program: ts.Program, pluginOptions: {}) {
    return (ctx: ts.TransformationContext) => {
        return (sourceFile: ts.SourceFile) => {
            function visitor(node: ts.Node): ts.VisitResult<ts.Node> {
                if (ts.isImportDeclaration(node)) {
                    // transform `import ... from '...'
                    const origImport = (node.moduleSpecifier as ts.StringLiteral).text
                    if (removeMap.has(origImport)) {
                        return node.importClause
                            ? importOrExportClauseToUMD(removeMap.get(origImport)!, node.importClause)
                            : undefined
                    }

                    const newPath = rewriteImport(origImport, sourceFile.fileName)
                    return ts.createImportDeclaration(
                        node.decorators,
                        node.modifiers,
                        node.importClause,
                        ts.createStringLiteral(newPath),
                    )
                } else if (ts.isExportDeclaration(node)) {
                    // transform `export ... from '...'`
                    if (!node.moduleSpecifier) return node
                    const origImport = (node.moduleSpecifier as ts.StringLiteral).text
                    if (removeMap.has(origImport) && node.exportClause) {
                        return importOrExportClauseToUMD(removeMap.get(origImport)!, node.exportClause)
                    }
                    const newPath = rewriteImport(origImport, sourceFile.fileName)
                    return ts.createExportDeclaration(
                        node.decorators,
                        node.modifiers,
                        node.exportClause,
                        ts.createStringLiteral(newPath),
                    )
                } else if (ts.isCallExpression(node)) {
                    // transform import(...)
                    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                        const firstArg = node.arguments[0]
                        if (ts.isStringLiteralLike(firstArg) && node.arguments.length === 1) {
                            const newPath = rewriteImport(firstArg.text, sourceFile.fileName)
                            return ts.createCall(importToken, undefined, [ts.createStringLiteral(newPath)])
                        }
                        return transformDynamicImport(node.arguments)
                    }
                }
                // TODO: transform import(...)
                return ts.visitEachChild(node, visitor, ctx)
            }
            return ts.visitEachChild(sourceFile, visitor, ctx)
        }
    }
}

// Code below is derived from https://github.com/pikapkg/web/blob/master/assets/babel-plugin.js
import * as path from 'path'
// A lame copy-paste from src/index.ts
function getWebDependencyName(dep: string) {
    return dep.replace(/\.js$/, '')
}
/**
 * import a from 'b' => const a = globalThis.b.default
 * import { a, b, c } from 'd' => const { a, b, c } = globalThis.b
 * import * as a from 'b' => const a = globalThis.b
 * TODO: in ts 3.8 there is namespace export.
 */
function importOrExportClauseToUMD(umdName: string, clause: ts.ImportClause | ts.NamedExports) {
    const umdNode = get__import_default(ts.createPropertyAccess(ts.createIdentifier('globalThis'), umdName))
    const umdNodeDefault = ts.createPropertyAccess(umdNode, 'default')
    const arr: ts.Statement[] = []
    if (ts.isImportClause(clause)) {
        const defaultImport = clause.name
        const nsImport =
            clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings : undefined
        const namedImport =
            clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings : undefined
        if (defaultImport) arr.push(getDefaultImport(defaultImport))
        if (nsImport) arr.push(getNamespaceImport(nsImport))
        if (namedImport) arr.push(getNamedImport(namedImport))
        return arr
    } else if (ts.isNamedExports(clause)) {
        // TODO: in ts 3.8 there is namespace export.
        // TODO: export clause doesn't introduce binding into the current lexical scope but this transform does.
        arr.push(getNamedImport(clause, [ts.createModifier(ts.SyntaxKind.ExportKeyword)]))
        return arr
    }
    return arr

    /**
     * ((mod) =>(mod && mod.__esModule) ? mod : { "default": mod })(globalThis.xyz)
     */
    function get__import_default(x: ts.PropertyAccessExpression) {
        return ts.createCall(
            ts.createParen(
                ts.createArrowFunction(
                    undefined,
                    undefined,
                    [
                        ts.createParameter(
                            undefined,
                            undefined,
                            undefined,
                            ts.createIdentifier('mod'),
                            undefined,
                            undefined,
                            undefined,
                        ),
                    ],
                    undefined,
                    ts.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                    ts.createConditional(
                        ts.createParen(
                            ts.createBinary(
                                ts.createIdentifier('mod'),
                                ts.createToken(ts.SyntaxKind.AmpersandAmpersandToken),
                                ts.createPropertyAccess(ts.createIdentifier('mod'), ts.createIdentifier('__esModule')),
                            ),
                        ),
                        ts.createIdentifier('mod'),
                        ts.createObjectLiteral(
                            [
                                ts.createPropertyAssignment(
                                    ts.createStringLiteral('default'),
                                    ts.createIdentifier('mod'),
                                ),
                            ],
                            false,
                        ),
                    ),
                ),
            ),
            undefined,
            [x],
        )
    }
    function getNamespaceImport(namedImport: ts.NamespaceImport) {
        return getAssignment(namedImport.name, umdNode)
    }
    function getDefaultImport(defaultImport: ts.Identifier) {
        return getAssignment(defaultImport, umdNodeDefault)
    }
    /** const _id_ = _target_ */
    function getAssignment(id: ts.Identifier, target: ts.Expression) {
        return ts.createVariableStatement(
            undefined,
            ts.createVariableDeclarationList([ts.createVariableDeclaration(id, undefined, target)], ts.NodeFlags.Const),
        )
    }

    function getNamedImport(namedImport: ts.NamedImportsOrExports, modifiers: ts.Modifier[] = []) {
        const elements: Array<ts.ImportSpecifier | ts.ExportSpecifier> = []
        namedImport.elements.forEach((y: typeof elements[0]) => elements.push(y))
        return ts.createVariableStatement(
            modifiers,
            ts.createVariableDeclarationList(
                [
                    ts.createVariableDeclaration(
                        ts.createObjectBindingPattern(
                            elements.map(x => ts.createBindingElement(undefined, undefined, x.name, undefined)),
                        ),
                        undefined,
                        umdNode,
                    ),
                ],
                ts.NodeFlags.Const,
            ),
        )
    }
}
function rewriteImport(imp: string, currentFilePath: string, dir = 'web_modules'): string {
    const projectBase = path.resolve(__dirname, '../src/')
    if (preTransformTable.has(imp)) imp = preTransformTable.get(imp)!
    const isSourceImport = imp.startsWith('.') || imp.startsWith('\\')
    const isRemoteImport = imp.startsWith('http://') || imp.startsWith('https://') || imp.startsWith('/')
    if (!isSourceImport && !isRemoteImport) {
        return path.posix.join('/', dir, `${getWebDependencyName(imp)}.js`)
    }
    const fullPath = path.join(path.dirname(currentFilePath), imp)
    if (path.extname(fullPath) === '.json') {
        if (fs.existsSync(fullPath)) {
            // No. Content Security Policy bans this.
            // return 'data:application/javascript,export default ' + fs.readFileSync(fullPath, 'utf-8')
            const json = fs.readFileSync(fullPath, 'utf-8')
            JSON.parse(json)
            const relative = path.relative(projectBase, fullPath).slice(undefined, -2)
            const resultPath = path.join(__dirname, '../esm-dist/' + relative)
            fs.writeFileSync(
                resultPath,
                `export default ${deepFreeze.name}(JSON.parse(${JSON.stringify(json)}))
${deepFreeze.toString()}`,
            )
            return imp.slice(undefined, -2)
        }
    }
    try {
        if (fs.existsSync(fullPath + '.js') || fs.existsSync(fullPath + '.ts') || fs.existsSync(fullPath + '.tsx')) {
            return imp + '.js'
        }
    } catch {}
    try {
        if (
            fs.existsSync(fullPath + '/index.js') ||
            fs.existsSync(fullPath + '/index.ts') ||
            fs.existsSync(fullPath + '/index.tsx')
        ) {
            return imp + '/index.js'
        }
    } catch {}
    return imp
}
/**
 * import(x) is transformed to
 *
import(
    (x =>
        x.match(/^(\.|\/)/g)
            ? // local import, startsWith . or /, check if end with .js
              x.endsWith('.js')
                ? x
                : x + '.js'
            : // remote import, do nothing (https?://)
            x.match(/^https?:\/\//g)
            ? x
            : // Bare import, change to /web_modules
              '/web_modules/' + x + '.js')(x)
)
 */
function transformDynamicImport(args: readonly ts.Expression[]) {
    return ts.createCall(importToken, undefined, [
        ts.createCall(
            ts.createParen(
                ts.createArrowFunction(
                    undefined,
                    undefined,
                    [
                        ts.createParameter(
                            undefined,
                            undefined,
                            undefined,
                            ts.createIdentifier('x'),
                            undefined,
                            undefined,
                            undefined,
                        ),
                    ],
                    undefined,
                    ts.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                    ts.createConditional(
                        ts.createCall(
                            ts.createPropertyAccess(ts.createIdentifier('x'), ts.createIdentifier('match')),
                            undefined,
                            [ts.createRegularExpressionLiteral('/^(.|/)/g')],
                        ),
                        ts.createConditional(
                            ts.createCall(
                                ts.createPropertyAccess(ts.createIdentifier('x'), ts.createIdentifier('endsWith')),
                                undefined,
                                [ts.createStringLiteral('.js')],
                            ),
                            ts.createIdentifier('x'),
                            ts.createBinary(
                                ts.createIdentifier('x'),
                                ts.createToken(ts.SyntaxKind.PlusToken),
                                ts.createStringLiteral('.js'),
                            ),
                        ),
                        ts.createConditional(
                            ts.createCall(
                                ts.createPropertyAccess(ts.createIdentifier('x'), ts.createIdentifier('match')),
                                undefined,
                                [ts.createRegularExpressionLiteral('/^https?:///g')],
                            ),
                            ts.createIdentifier('x'),
                            ts.createBinary(
                                ts.createBinary(
                                    ts.createStringLiteral('/web_modules/'),
                                    ts.createToken(ts.SyntaxKind.PlusToken),
                                    ts.createIdentifier('x'),
                                ),
                                ts.createToken(ts.SyntaxKind.PlusToken),
                                ts.createStringLiteral('.js'),
                            ),
                        ),
                    ),
                ),
            ),
            undefined,
            args,
        ),
    ])
}
function deepFreeze(o: object) {
    Object.freeze(o)
    Object.getOwnPropertyNames(o).forEach(function(prop) {
        if (!Object.prototype.hasOwnProperty.call(o, prop)) return
        const _ = Reflect.get(o, prop)
        if (_ === null) return
        if ((typeof _ === 'object' || typeof _ === 'function') && !Object.isFrozen(_)) deepFreeze(_)
    })
    return o
}
