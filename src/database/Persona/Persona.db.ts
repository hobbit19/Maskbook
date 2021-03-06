/// <reference path="../global.d.ts" />

import { ProfileIdentifier, PersonaIdentifier, Identifier, ECKeyIdentifier } from '../type'
import { DBSchema, openDB } from 'idb/with-async-ittr'
import { IdentifierMap } from '../IdentifierMap'
import { PrototypeLess, restorePrototype } from '../../utils/type'
import { MessageCenter } from '../../utils/messages'
import { createDBAccess, IDBPSafeTransaction, createTransaction } from '../helpers/openDB'
import { queryProfile } from './helpers'
import { assertPersonaDBConsistency } from './consistency'
/**
 * Database structure:
 *
 * # ObjectStore `persona`:
 * @description Store Personas.
 * @type {PersonaRecordDb}
 * @keys inline, {@link PersonaRecordDb.identifier}
 *
 * # ObjectStore `profiles`:
 * @description Store profiles.
 * @type {ProfileRecord}
 * A persona links to 0 or more profiles.
 * Each profile links to 0 or 1 persona.
 * @keys inline, {@link ProfileRecord.identifier}
 */

const db = createDBAccess(() => {
    return openDB<PersonaDB>('maskbook-persona', 1, {
        upgrade(db, oldVersion, newVersion, transaction) {
            function v0_v1() {
                db.createObjectStore('personas', { keyPath: 'identifier' })
                db.createObjectStore('profiles', { keyPath: 'identifier' })
                transaction.objectStore('profiles').createIndex('network', 'network', { unique: false })
                transaction.objectStore('personas').createIndex('hasPrivateKey', 'hasPrivateKey', { unique: false })
            }
            if (oldVersion < 1) v0_v1()
        },
    })
})
export type FullPersonaDBTransaction<Mode extends 'readonly' | 'readwrite'> = IDBPSafeTransaction<
    PersonaDB,
    ['personas', 'profiles'],
    Mode
>
export type ProfileTransaction<Mode extends 'readonly' | 'readwrite'> = IDBPSafeTransaction<
    PersonaDB,
    ['profiles'],
    Mode
>
export type PersonasTransaction<Mode extends 'readonly' | 'readwrite'> = IDBPSafeTransaction<
    PersonaDB,
    ['personas'],
    Mode
>
export async function consistentPersonaDBWriteAccess(
    action: (t: FullPersonaDBTransaction<'readwrite'>) => Promise<void>,
    tryToAutoFix = true,
) {
    // TODO: collect all changes on this transaction then only perform consistency check on those records.
    let t = createTransaction(await db(), 'readwrite')('profiles', 'personas')
    let finished = false
    const finish = () => (finished = true)
    t.addEventListener('abort', finish)
    t.addEventListener('complete', finish)
    t.addEventListener('error', finish)

    try {
        await action(t)
    } finally {
        if (finished) {
            console.warn('The transaction ends too early! There MUST be a bug in the program!')
            console.trace()
            // start a new transaction to check consistency
            t = createTransaction(await db(), 'readwrite')('profiles', 'personas')
        }
        await assertPersonaDBConsistency(tryToAutoFix ? 'fix' : 'throw', 'full check', t)
    }
}

//#region Plain methods
/**
 * Create a new Persona.
 * If the record contains `privateKey`, it will be stored in the `self` store.
 * Otherwise, it will be stored in the `others` store.
 */
export async function createPersonaDB(record: PersonaRecord, t: PersonasTransaction<'readwrite'>): Promise<void> {
    await t.objectStore('personas').add(personaRecordToDB(record))
    MessageCenter.emit('personaCreated', undefined)
    MessageCenter.emit('personaUpdated', undefined)
}

export async function queryPersonaByProfileDB(
    query: ProfileIdentifier,
    t?: FullPersonaDBTransaction<'readonly'>,
): Promise<PersonaRecord | null> {
    t = t || createTransaction(await db(), 'readonly')('personas', 'profiles')
    const x = await t.objectStore('profiles').get(query.toText())
    if (!x?.linkedPersona) return null
    return queryPersonaDB(restorePrototype(x.linkedPersona, ECKeyIdentifier.prototype), t)
}

/**
 * Query a Persona.
 */
export async function queryPersonaDB(
    query: PersonaIdentifier,
    t?: PersonasTransaction<'readonly'>,
): Promise<PersonaRecord | null> {
    t = t || createTransaction(await db(), 'readonly')('personas')
    const x = await t.objectStore('personas').get(query.toText())
    if (x) return personaRecordOutDb(x)
    return null
}

/**
 * Query many Personas.
 */
export async function queryPersonasDB(
    query: (record: PersonaRecord) => boolean,
    t?: PersonasTransaction<'readonly'>,
): Promise<PersonaRecord[]> {
    t = t || createTransaction(await db(), 'readonly')('personas')
    const records: PersonaRecord[] = []
    for await (const each of t.objectStore('personas')) {
        const out = personaRecordOutDb(each.value)
        if (query(out)) records.push(out)
    }
    return records
}

export type PersonaRecordWithPrivateKey = PersonaRecord & Required<Pick<PersonaRecord, 'privateKey'>>
/**
 * Query many Personas.
 */
export async function queryPersonasWithPrivateKey(
    t?: FullPersonaDBTransaction<'readonly'>,
): Promise<PersonaRecordWithPrivateKey[]> {
    t = t || createTransaction(await db(), 'readonly')('personas', 'profiles')
    const records: PersonaRecord[] = []
    records.push(
        ...(
            await t
                .objectStore('personas')
                .index('hasPrivateKey')
                .getAll(IDBKeyRange.only('yes'))
        ).map(personaRecordOutDb),
    )
    return records as PersonaRecordWithPrivateKey[]
}

/**
 * Update an existing Persona record.
 * @param nextRecord The partial record to be merged
 * @param howToMerge How to merge linkedProfiles and `field: undefined`
 * @param t transaction
 */
export async function updatePersonaDB(
    // Do a copy here. We need to delete keys from it.
    { ...nextRecord }: Readonly<Partial<PersonaRecord> & Pick<PersonaRecord, 'identifier'>>,
    howToMerge: {
        linkedProfiles: 'replace' | 'merge'
        explicitUndefinedField: 'ignore' | 'delete field'
    },
    t: PersonasTransaction<'readwrite'>,
): Promise<void> {
    const _old = await t.objectStore('personas').get(nextRecord.identifier.toText())
    if (!_old) throw new TypeError('Update an non-exist data')
    const old = personaRecordOutDb(_old)
    let nextLinkedProfiles = old.linkedProfiles
    if (nextRecord.linkedProfiles) {
        if (howToMerge.linkedProfiles === 'merge')
            nextLinkedProfiles = new IdentifierMap(
                new Map([...nextLinkedProfiles.__raw_map__, ...nextRecord.linkedProfiles.__raw_map__]),
            )
        else nextLinkedProfiles = nextRecord.linkedProfiles
    }
    if (howToMerge.explicitUndefinedField === 'ignore') {
        for (const _key in nextRecord) {
            const key = _key as keyof typeof nextRecord
            if (nextRecord[key] === undefined) {
                delete nextRecord[key as keyof typeof nextRecord]
            }
        }
    }
    const next: PersonaRecordDb = personaRecordToDB({
        ...old,
        ...nextRecord,
        linkedProfiles: nextLinkedProfiles,
        updatedAt: new Date(),
    })
    await t.objectStore('personas').put(next)
    MessageCenter.emit('personaUpdated', undefined)
}

export async function createOrUpdatePersonaDB(
    record: Partial<PersonaRecord> & Pick<PersonaRecord, 'identifier' | 'publicKey'>,
    howToMerge: Parameters<typeof updatePersonaDB>[1],
    t: PersonasTransaction<'readwrite'>,
) {
    if (await t.objectStore('personas').get(record.identifier.toText())) return updatePersonaDB(record, howToMerge, t)
    else
        return createPersonaDB(
            {
                ...record,
                createdAt: new Date(),
                updatedAt: new Date(),
                linkedProfiles: new IdentifierMap(new Map()),
            },
            t,
        )
}

/**
 * Delete a Persona
 */
export async function deletePersonaDB(
    id: PersonaIdentifier,
    confirm: 'delete even with private' | "don't delete if have private key",
    t: PersonasTransaction<'readwrite'>,
): Promise<void> {
    const r = await t.objectStore('personas').get(id.toText())
    if (!r) return
    if (confirm !== 'delete even with private' && r.privateKey)
        throw new TypeError('Cannot delete a persona with a private key')
    await t.objectStore('personas').delete(id.toText())
    MessageCenter.emit('personaUpdated', undefined)
}
/**
 * Delete a Persona
 * @returns a boolean. true: the record no longer exists; false: the record is kept.
 */
export async function safeDeletePersonaDB(
    id: PersonaIdentifier,
    t?: FullPersonaDBTransaction<'readwrite'>,
): Promise<boolean> {
    t = t || createTransaction(await db(), 'readwrite')('personas', 'profiles')
    const r = await queryPersonaDB(id, t)
    if (!r) return true
    if (r.linkedProfiles.size !== 0) return false
    if (r.privateKey) return false
    await deletePersonaDB(id, "don't delete if have private key", t)
    MessageCenter.emit('personaUpdated', undefined)
    return true
}

/**
 * Create a new profile.
 */
export async function createProfileDB(record: ProfileRecord, t: ProfileTransaction<'readwrite'>): Promise<void> {
    await t.objectStore('profiles').add(profileToDB(record))
    setTimeout(async () => {
        MessageCenter.emit('identityCreated', undefined)
        MessageCenter.emit('profilesChanged', [{ reason: 'new', of: await queryProfile(record.identifier) }])
    }, 0)
}

/**
 * Query a profile.
 */
export async function queryProfileDB(
    id: ProfileIdentifier,
    t?: ProfileTransaction<'readonly'>,
): Promise<ProfileRecord | null> {
    t = t || createTransaction(await db(), 'readonly')('profiles')
    const result = await t.objectStore('profiles').get(id.toText())
    if (result) return profileOutDB(result)
    return null
}

/**
 * Query many profiles.
 */
export async function queryProfilesDB(
    network: string | ((record: ProfileRecord) => boolean),
    t?: ProfileTransaction<'readonly'>,
): Promise<ProfileRecord[]> {
    t = t || createTransaction(await db(), 'readonly')('profiles')
    const result: ProfileRecord[] = []
    if (typeof network === 'string') {
        result.push(
            ...(
                await t
                    .objectStore('profiles')
                    .index('network')
                    .getAll(IDBKeyRange.only(network))
            ).map(profileOutDB),
        )
    } else {
        for await (const each of t.objectStore('profiles').iterate()) {
            const out = profileOutDB(each.value)
            if (network(out)) result.push(out)
        }
    }
    return result
}

/**
 * Update a profile.
 */
export async function updateProfileDB(
    updating: Partial<ProfileRecord> & Pick<ProfileRecord, 'identifier'>,
    t: ProfileTransaction<'readwrite'>,
): Promise<void> {
    const old = await t.objectStore('profiles').get(updating.identifier.toText())
    if (!old) throw new Error('Updating a non exists record')

    const nextRecord: ProfileRecordDB = profileToDB({
        ...profileOutDB(old),
        ...updating,
    })
    await t.objectStore('profiles').put(nextRecord)
    setTimeout(
        async () =>
            MessageCenter.emit('profilesChanged', [
                { reason: 'update', of: await queryProfile(updating.identifier) } as const,
            ]),
        0,
    )
}
export async function createOrUpdateProfileDB(rec: ProfileRecord, t: ProfileTransaction<'readwrite'>) {
    if (await queryProfileDB(rec.identifier, t)) return updateProfileDB(rec, t)
    else return createProfileDB(rec, t)
}

/**
 * detach a profile.
 */
export async function detachProfileDB(
    identifier: ProfileIdentifier,
    t?: FullPersonaDBTransaction<'readwrite'>,
): Promise<void> {
    t = t || createTransaction(await db(), 'readwrite')('personas', 'profiles')
    const profile = await queryProfileDB(identifier, t)
    if (!profile?.linkedPersona) return

    const linkedPersona = profile.linkedPersona
    const persona = await queryPersonaDB(linkedPersona, t)
    persona?.linkedProfiles.delete(identifier)

    if (persona) {
        // if (await safeDeletePersonaDB(linkedPersona, t)) {
        // persona deleted
        // } else {
        // update persona
        await updatePersonaDB(persona, { linkedProfiles: 'replace', explicitUndefinedField: 'delete field' }, t)
        // }
    }
    // update profile
    profile.linkedPersona = undefined
    await updateProfileDB(profile, t)
}

/**
 * attach a profile.
 */
export async function attachProfileDB(
    identifier: ProfileIdentifier,
    attachTo: PersonaIdentifier,
    data: LinkedProfileDetails,
    t?: FullPersonaDBTransaction<'readwrite'>,
): Promise<void> {
    t = t || createTransaction(await db(), 'readwrite')('personas', 'profiles')
    const profile =
        (await queryProfileDB(identifier, t)) ||
        (await createProfileDB({ identifier, createdAt: new Date(), updatedAt: new Date() }, t)) ||
        (await queryProfileDB(identifier, t))
    const persona = await queryPersonaDB(attachTo, t)
    if (!persona || !profile) return

    if (profile.linkedPersona !== undefined && !profile.linkedPersona.equals(attachTo)) {
        await detachProfileDB(identifier, t)
    }

    profile.linkedPersona = attachTo
    persona.linkedProfiles.set(identifier, data)

    await updatePersonaDB(persona, { linkedProfiles: 'merge', explicitUndefinedField: 'ignore' }, t)
    await updateProfileDB(profile, t)
    MessageCenter.emit('identityUpdated', undefined)
}

/**
 * Delete a profile
 */
export async function deleteProfileDB(id: ProfileIdentifier, t: ProfileTransaction<'readwrite'>): Promise<void> {
    await t.objectStore('profiles').delete(id.toText())
    queryProfile(id).then(of => MessageCenter.emit('profilesChanged', [{ reason: 'delete', of } as const]))
}

//#endregion

//#region Type
export interface ProfileRecord {
    identifier: ProfileIdentifier
    nickname?: string
    localKey?: CryptoKey
    linkedPersona?: PersonaIdentifier
    createdAt: Date
    updatedAt: Date
}

export interface LinkedProfileDetails {
    connectionConfirmState: 'confirmed' | 'pending' | 'denied'
}

export interface PersonaRecord {
    identifier: PersonaIdentifier
    /**
     * If this key is generated by the mnemonic word, this field should be set.
     */
    mnemonic?: {
        words: string
        parameter: { path: string; withPassword: boolean }
    }
    publicKey: JsonWebKey
    privateKey?: JsonWebKey
    localKey?: CryptoKey
    nickname?: string
    linkedProfiles: IdentifierMap<ProfileIdentifier, LinkedProfileDetails>
    createdAt: Date
    updatedAt: Date
}
type ProfileRecordDB = Omit<ProfileRecord, 'identifier' | 'hasPrivateKey' | 'linkedPersona'> & {
    identifier: string
    network: string
    linkedPersona?: PrototypeLess<PersonaIdentifier>
}
type PersonaRecordDb = Omit<PersonaRecord, 'identifier' | 'linkedProfiles'> & {
    identifier: string
    linkedProfiles: Map<string, LinkedProfileDetails>
    /**
     * This field is used as index of the db.
     */
    hasPrivateKey: 'no' | 'yes'
}

export interface PersonaDB extends DBSchema {
    /** Use inline keys */
    personas: {
        value: PersonaRecordDb
        key: string
        indexes: {
            hasPrivateKey: string
        }
    }
    /** Use inline keys */
    profiles: {
        value: ProfileRecordDB
        key: string
        indexes: {
            // Use `network` field as index
            network: string
        }
    }
}
//#endregion

//#region out db & to db
function profileToDB(x: ProfileRecord): ProfileRecordDB {
    return {
        ...x,
        identifier: x.identifier.toText(),
        network: x.identifier.network,
    }
}
function profileOutDB({ network, ...x }: ProfileRecordDB): ProfileRecord {
    if (x.linkedPersona) {
        if (x.linkedPersona.type !== 'ec_key') throw new Error('Unknown type of linkedPersona')
    }
    return {
        ...x,
        identifier: Identifier.fromString(x.identifier, ProfileIdentifier).unwrap(
            `Invalid identifier found, expected ProfileIdentifier, actual ${x.identifier}`,
        ),
        linkedPersona: restorePrototype(x.linkedPersona, ECKeyIdentifier.prototype),
    }
}
function personaRecordToDB(x: PersonaRecord): PersonaRecordDb {
    return {
        ...x,
        identifier: x.identifier.toText(),
        hasPrivateKey: x.privateKey ? 'yes' : 'no',
        linkedProfiles: x.linkedProfiles.__raw_map__,
    }
}
function personaRecordOutDb(x: PersonaRecordDb): PersonaRecord {
    delete x.hasPrivateKey
    const obj: PersonaRecord = {
        ...x,
        identifier: Identifier.fromString(x.identifier, ECKeyIdentifier).unwrap(
            `This record has an invalid identifier, wanted ECKeyIdentifier, ${x.identifier}`,
        ),
        linkedProfiles: new IdentifierMap(x.linkedProfiles, ProfileIdentifier),
    }
    return obj
}
//#endregion
