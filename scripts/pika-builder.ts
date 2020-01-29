import * as ts from 'typescript'
import * as fs from 'fs'
// @ts-ignore
import * as _removeMap from './pika-webpack-builder.js'
const removeMap: Map<string, string> = _removeMap

const preTransformTable = new Map<string, string>()
preTransformTable.set('@holoflows/kit/es', '@holoflows/kit')
preTransformTable.set('tiny-secp256k1', '/umd_modules/tiny-secp256k1.js')
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
