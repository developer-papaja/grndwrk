/**
 * The page's build puts api-store.ts where api.ts is, so it must offer every
 * call api.ts does. A call added to one and not the other fails the type check here.
 */
import type * as Mac from '../api'
import type * as Page from '../api-store'

type Missing = Exclude<keyof typeof Mac, keyof typeof Page>
export const everyCall: [Missing] extends [never] ? true : Missing = true
