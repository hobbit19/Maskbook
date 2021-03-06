const path = require('path')
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'jest-environment-jsdom-fourteen',
    globals: {
        'ts-jest': {
            isolatedModules: true,
        },
    },
    globalSetup: path.join(__dirname, './scripts/jest-global-setup'),
    setupFiles: [
        require.resolve('react-app-polyfill/jsdom'),
        require.resolve('fake-indexeddb/auto'),
        path.join(__dirname, './scripts/jest-setup.js'),
    ],
    moduleNameMapper: {
        '^@holoflows/kit.+$': require.resolve('@holoflows/kit/umd/index.js'),
        'lodash-es': require.resolve('lodash'),
        'idb/with-async-ittr': require.resolve('idb/build/cjs/index.js'),
    },
}
