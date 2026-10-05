/**
 * Who is reviewing. A tenant reviewer acts inside one tenant; the platform reviewer (service) is the
 * only one who may review global knowledge.
 */
export type Actor = { readonly kind: 'tenant'; readonly tenantId: string } | { readonly kind: 'service' };
