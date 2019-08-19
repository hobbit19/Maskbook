import { SocialNetworkWorker } from '../../social-network/worker'
import getCurrentNetworkWorker from '../../social-network/utils/getCurrentNetworkWorker'
import { Identifier } from '../../database/type'
import { GetContext, AsyncCall, OnlyRunInContext } from '@holoflows/kit/es'
import Serialization from '../../utils/type-transform/Serialization'
import { memoize } from 'lodash-es'

type ServiceType = Required<Pick<SocialNetworkWorker, 'autoVerifyBio' | 'autoVerifyPost' | 'manualVerifyPost'>>

const getServiceFromNetworkWorker = memoize((worker: SocialNetworkWorker) => {
    return AsyncCall<ServiceType>(undefined, { serializer: Serialization, key: worker.internalName })
})
export function getCurrentNetworkWorkerService(network: string | Identifier) {
    if (GetContext() === 'background') {
        throw new Error('This function is not for this env')
    }
    const worker = getCurrentNetworkWorker(network)
    return getServiceFromNetworkWorker(worker)
}

const notImplemented = () => {
    throw new Error('Not Implemented')
}
export function startWorkerService(e: SocialNetworkWorker) {
    OnlyRunInContext('background', 'defineWorkerService')
    const impl: ServiceType = {
        autoVerifyBio: e.autoVerifyBio || notImplemented,
        autoVerifyPost: e.autoVerifyPost || notImplemented,
        manualVerifyPost: e.manualVerifyPost || notImplemented,
    }
    AsyncCall(impl, { serializer: Serialization, key: e.internalName })
}