import { Payload, PayloadAlpha38 } from '../../../utils/type-transform/Payload'
import stringify from 'json-stable-stringify'

export function getSignablePayload(payload: Payload) {
    if (payload.version >= -37) {
        return stringify({
            encryptedText: payload.encryptedText,
            iv: payload.iv,
            ownersKey: (payload as PayloadAlpha38).AESKeyEncrypted,
        })
    }
    // ! Don't use payload.ts, this is an internal representation used for signature.
    else
        return `4/4|${payload.version === -38 ? payload.AESKeyEncrypted : payload.ownersAESKeyEncrypted}|${
            payload.iv
        }|${payload.encryptedText}`
}

import * as Alpha40 from '../../../crypto/crypto-alpha-40'
import * as Alpha39 from '../../../crypto/crypto-alpha-39'
import * as Alpha38 from '../../../crypto/crypto-alpha-38'
import { RedPacketJSONPayload } from '../../../plugins/Wallet/database/types'
import { Nullable } from '../../../utils/type-transform/Nullable'

export const cryptoProviderTable = {
    [-40]: Alpha40,
    [-39]: Alpha39,
    [-38]: Alpha38,
} as const

export interface TypedMessageMetadata {
    readonly meta?: ReadonlyMap<string, any>
    readonly version: 1
}
export interface TypedMessageText extends TypedMessageMetadata {
    readonly type: 'text'
    readonly content: string
}
export interface TypedMessageComplex extends TypedMessageMetadata {
    readonly type: 'complex'
    readonly items: readonly TypedMessage[]
}
export interface TypedMessageUnknown extends TypedMessageMetadata {
    readonly type: 'unknown'
}
export type TypedMessage = TypedMessageText | TypedMessageComplex | TypedMessageUnknown
export function makeTypedMessage(text: string, meta?: ReadonlyMap<string, any>): TypedMessageText
export function makeTypedMessage(content: string, meta?: ReadonlyMap<string, any>): TypedMessage {
    if (typeof content === 'string') {
        const text: TypedMessageText = { type: 'text', content, version: 1, meta }
        return text
    }
    const msg: TypedMessageUnknown = { type: 'unknown', version: 1, meta }
    return msg
}

interface KnownMetadata {
    'com.maskbook.red_packet:1': RedPacketJSONPayload
}
const builtinMetadataSchema: Partial<Record<string, object>> = {} as Partial<Record<keyof KnownMetadata, object>>
export function readTypedMessageMetadata<T extends keyof KnownMetadata>(
    meta: ReadonlyMap<string, any> | undefined,
    key: T,
    jsonSchema?: object,
): Nullable<KnownMetadata[T]> {
    return readTypedMessageMetadataUntyped(meta, key, jsonSchema)
}
export function readTypedMessageMetadataUntyped<T>(
    meta: ReadonlyMap<string, any> | undefined,
    key: string,
    jsonSchema?: object,
): Nullable<T> {
    if (!meta) return Nullable(null)
    if (!meta.has(key)) return Nullable(null)
    if (!jsonSchema) {
        console.warn('You should add a JSON Schema to verify the metadata')
    } else {
        if (key in builtinMetadataSchema && builtinMetadataSchema[key] && !jsonSchema)
            jsonSchema = builtinMetadataSchema[key]
        // TODO: validate the schema.
    }
    return Nullable(meta.get(key))
}

export function withMetadata<T extends keyof KnownMetadata>(
    meta: ReadonlyMap<string, any> | undefined,
    key: T,
    render: (data: KnownMetadata[T]) => React.ReactNode,
    jsonSchema?: object,
): React.ReactNode | null {
    return withMetadataUntyped(meta, key, render as any, jsonSchema)
}
export function withMetadataUntyped(
    meta: ReadonlyMap<string, any> | undefined,
    key: string,
    render: (data: unknown) => React.ReactNode,
    jsonSchema?: object,
): React.ReactNode | null {
    const message = readTypedMessageMetadataUntyped(meta, key, jsonSchema)
    if (message.value) return render(message.value)
    return null
}

export function extractTextFromTypedMessage(x: TypedMessage | null): Nullable<string> {
    if (x === null) return Nullable(null)
    if (x.type === 'text') return Nullable(x.content)
    if (x.type === 'complex')
        return Nullable(
            x.items.map(extractTextFromTypedMessage).filter(x => x.hasValue && x.value!.length > 0)[0].value,
        )
    return Nullable(null)
}
