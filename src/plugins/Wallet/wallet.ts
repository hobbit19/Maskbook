import { createTransaction, IDBPSafeTransaction } from '../../database/helpers/openDB'
import { createWalletDBAccess, WalletDB } from './database/Wallet.db'
import { WalletRecord, ERC20TokenRecord, EthereumNetwork } from './database/types'
import { assert } from './red-packet-fsm'
import { PluginMessageCenter } from '../PluginMessages'
import { HDKey, EthereumAddress } from 'wallet.ts'
import * as bip39 from 'bip39'
import { walletAPI } from './real'
import { ERC20TokenPredefinedData } from './erc20'
import { memoizePromise } from '../../utils/memoize'
import { currentEthereumNetworkSettings } from './network'
import { buf2hex } from './web3'

// Private key at m/44'/coinType'/account'/change/addressIndex
// coinType = ether
const path = "m/44'/60'/0'/0/0"
export function getWalletProvider() {
    return walletAPI
}
const memoGetWalletBalance = memoizePromise(
    (addr: string) => {
        return getWalletProvider()
            .queryBalance(addr)
            .then(x => onWalletBalanceUpdated(addr, x))
    },
    x => x,
)
const memoQueryERC20Token = memoizePromise(
    (addr: string, erc20Addr: string) => {
        return getWalletProvider()
            .queryERC20TokenBalance(addr, erc20Addr)
            .then(x => onWalletERC20TokenBalanceUpdated(addr, erc20Addr, x))
            .catch(() => {
                // do nothing
            })
    },
    (x, y) => x + ',' + y,
)
const clearCache = () => {
    memoGetWalletBalance?.cache?.clear?.()
    memoQueryERC20Token?.cache?.clear?.()
}
PluginMessageCenter.on('maskbook.red_packets.update', () => {
    clearCache()
    PluginMessageCenter.emit('maskbook.wallets.update', undefined)
})
/** Cache most valid for 15 seconds */
setInterval(clearCache, 1000 * 15)
currentEthereumNetworkSettings.addListener(() => {
    clearCache()
    PluginMessageCenter.emit('maskbook.wallets.update', undefined)
})
export async function getWallets(): Promise<[(WalletRecord & { privateKey: string })[], ERC20TokenRecord[]]> {
    const t = createTransaction(await createWalletDBAccess(), 'readonly')('Wallet', 'ERC20Token')
    const wallets = await t.objectStore('Wallet').getAll()
    const tokens = await t.objectStore('ERC20Token').getAll()
    // Schedule an update
    for (const x of wallets) {
        memoGetWalletBalance(x.address)
        for (const t of x.erc20_token_balance.keys()) memoQueryERC20Token(x.address, t)
    }
    return [
        await Promise.all(
            wallets.map(async x => ({
                ...x,
                privateKey: '0x' + buf2hex((await recoverWallet(x.mnemonic, x.passphrase)).privateKey),
            })),
        ),
        tokens,
    ]
}

export async function createNewWallet(
    rec: Omit<WalletRecord, 'id' | 'address' | 'mnemonic' | 'eth_balance' | '_data_source_' | 'erc20_token_balance'>,
) {
    const mnemonic = bip39.generateMnemonic().split(' ')
    importNewWallet({ mnemonic, ...rec })
}

export async function importNewWallet(
    rec: Omit<WalletRecord, 'id' | 'address' | 'eth_balance' | '_data_source_' | 'erc20_token_balance'>,
) {
    const { address } = await recoverWallet(rec.mnemonic, rec.passphrase)
    const bal = await getWalletProvider()
        .queryBalance(address)
        .catch(x => undefined)
    const record: WalletRecord = {
        ...rec,
        address,
        eth_balance: bal,
        /** Builtin Dai Stablecoin */
        erc20_token_balance: new Map([['0x6B175474E89094C44Da98b954EedeAC495271d0F', undefined]]),
        _data_source_: getWalletProvider().dataSource,
    }
    {
        const t = createTransaction(await createWalletDBAccess(), 'readwrite')('Wallet', 'ERC20Token')
        t.objectStore('Wallet')
            .add(record)
            .then(() => PluginMessageCenter.emit('maskbook.wallets.reset', undefined, true))
        t.objectStore('ERC20Token').put({
            decimals: 18,
            symbol: 'DAI',
            name: 'Dai Stablecoin',
            address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
            network: EthereumNetwork.Mainnet,
            is_user_defined: false,
        })
    }
    PluginMessageCenter.emit('maskbook.wallets.update', undefined)
}

export async function onWalletBalanceUpdated(address: string, newBalance: bigint) {
    const t = createTransaction(await createWalletDBAccess(), 'readwrite')('Wallet')
    const wallet = await getWalletByAddress(t, address)
    if (wallet.eth_balance === newBalance) return
    wallet.eth_balance = newBalance
    t.objectStore('Wallet').put(wallet)
    PluginMessageCenter.emit('maskbook.wallets.update', undefined)
}

export async function renameWallet(address: string, name: string) {
    const t = createTransaction(await createWalletDBAccess(), 'readwrite')('Wallet')
    const wallet = await getWalletByAddress(t, address)

    wallet.name = name
    t.objectStore('Wallet').put(wallet)
    PluginMessageCenter.emit('maskbook.wallets.update', undefined)
}

export async function removeWallet(address: string) {
    const t = createTransaction(await createWalletDBAccess(), 'readwrite')('Wallet')
    const wallet = await getWalletByAddress(t, address)
    {
        const t = createTransaction(await createWalletDBAccess(), 'readwrite')('Wallet')
        t.objectStore('Wallet')
            .delete(wallet.address)
            .then(() => PluginMessageCenter.emit('maskbook.wallets.reset', undefined, true))
    }
    PluginMessageCenter.emit('maskbook.wallets.update', undefined)
}

export async function recoverWallet(mnemonic: string[], password: string) {
    const seed = await bip39.mnemonicToSeed(mnemonic.join(' '), password)
    const masterKey = HDKey.parseMasterSeed(seed)
    const extendedPrivateKey = masterKey.derive(path).extendedPrivateKey!
    const childKey = HDKey.parseExtendedKey(extendedPrivateKey)

    const wallet = childKey.derive('')
    const walletPublicKey = wallet.publicKey
    const walletPrivateKey = wallet.privateKey!
    const address = EthereumAddress.from(walletPublicKey).address
    return { address, privateKey: walletPrivateKey, mnemonic }
}

export async function walletAddERC20Token(
    walletAddress: string,
    network: EthereumNetwork,
    token: ERC20TokenPredefinedData[0],
    user_defined: boolean,
) {
    const bal = await getWalletProvider()
        .queryERC20TokenBalance(walletAddress, token.address)
        .catch(() => undefined)

    const t = createTransaction(await createWalletDBAccess(), 'readwrite')('ERC20Token', 'Wallet')
    const wallet = await getWalletByAddress(t, walletAddress)
    const erc20 = await t.objectStore('ERC20Token').get(token.address)
    if (!erc20) {
        const rec: ERC20TokenRecord = {
            address: token.address,
            decimals: token.decimals,
            is_user_defined: user_defined,
            name: token.name,
            network: network,
            symbol: token.symbol,
        }
        await t.objectStore('ERC20Token').add(rec)
    }
    wallet.erc20_token_balance.set(token.address, bal)
    await t.objectStore('Wallet').put(wallet)
}

export async function onWalletERC20TokenBalanceUpdated(address: string, tokenAddress: string, newBalance: bigint) {
    const t = createTransaction(await createWalletDBAccess(), 'readwrite')('Wallet')
    const wallet = await getWalletByAddress(t, address)
    if (wallet.erc20_token_balance.get(tokenAddress) === newBalance) return
    wallet.erc20_token_balance.set(tokenAddress, newBalance)
    t.objectStore('Wallet').put(wallet)
    PluginMessageCenter.emit('maskbook.wallets.update', undefined)
}

async function getWalletByAddress(t: IDBPSafeTransaction<WalletDB, ['Wallet'], 'readonly'>, address: string) {
    const rec = await t.objectStore('Wallet').get(address)
    assert(rec)
    return rec
}
