const simpleSet = [
    'bip39',
    'web3',
    'jsonwebtoken',
    'gun',
    'wallet.ts',
    'web3-utils',
    'uuid/v4',
    'tiny-secp256k1',
    'node-stego/es/dom',
    'node-stego/es/transform',
    'node-stego/es/grayscale',
    'node-stego/es/helper',
    'gun/sea',
]
const map = (module.exports = new Map([
    ['gun/gun', 'gun'],
    ['gun/lib/then', 'gun_then'],
]))

for (const x of simpleSet) map.set(x, x.replace(/\/|\.|-/g, '_'))
for (const [key, value] of map) map.set(key, '_webpack_dependencies_' + value)
map.set('webextension-polyfill', 'browser')

const path = require('path')
const fs = require('fs')
function main() {
    const webpack = require('webpack')
    const temp = path.resolve(__dirname, '../esm-dist/temp.js')
    webpack({
        entry: async () => {
            fs.writeFileSync(
                temp,
                Array.from(map).reduce(
                    (prev, [pkg, umd]) => {
                        return prev + '\n' + `globalThis.${umd} = require("${pkg}")`
                    },
                    `
{
    ${patchFunction.toString()}
    ${patchFunction.name}()
}
`,
                ),
            )
            return [temp]
        },
        output: { path: path.resolve(__dirname, '../esm-dist/'), filename: 'umd_dependencies.js' },
    }).run((err, stat) => {
        fs.unlinkSync(temp)
        if (err) throw err
        const missing = stat.compilation.missingDependencies.size
        if (missing) console.error('Missing dependencies', stat.compilation.missingDependencies)
    })
}

if (process.mainModule === module) {
    main()
}

function patchFunction() {
    const f = globalThis.Function
    globalThis.Function = new Proxy(f, {
        apply(target, thisArg, [a, b, ...args]) {
            if (a === 'r' && b === 'regeneratorRuntime = r') return r => (globalThis.regeneratorRuntime = r)
            else return f(a, b, ...args)
        },
    })
}

const generateFileMap = new Map()
generateFileMap.set(
    'background.html',
    `<!DOCTYPE html>
<html>
    <head>
        <meta charset="UTF-8" />
    </head>
    <body>
        <script src="/firefoxFix.js"></script>
        <script src="/env.js"></script>
        <script src="/require.js"></script>
        <script src="/umd_dependencies.js"></script>
        <script type="module" src="/background-service.js"></script>
    </body>
</html>`,
)
generateFileMap.set(
    'manifest.json',
    `{
    "$schema": "http://json.schemastore.org/chrome-manifest",
    "name": "Maskbook WebExt test",
    "version": "1.42.0",
    "manifest_version": 2,
    "web_accessible_resources": ["*.css", "*.js", "*.jpg", "*.png"],
    "permissions": ["storage", "downloads", "webNavigation", "activeTab"],
    "optional_permissions": ["<all_urls>"],
    "background": {
        "page": "background.html"
    },
    "homepage_url": "https://maskbook.com",
    "description": "",
    "default_locale": "en"
}`,
)
generateFileMap.set(
    'require.js',
    `globalThis.require = function require(...args) {
    console.log('require:', ...args)
    return {}
}`,
)
generateFileMap.set('generated__content__script.html', `<html></html>`)
generateFileMap.set('env.js', fs.readFileSync(path.join(__dirname, '../public/env.js')))
generateFileMap.set('firefoxFix.js', fs.readFileSync(path.join(__dirname, '../public/firefoxFix.js')))

const esmDist = path.join(__dirname, '../esm-dist')
for (const [filename, content] of generateFileMap) {
    fs.writeFileSync(path.join(esmDist, filename), content)
}
