// Alpine's CSP build has the same API as Alpine; it reads expressions without eval.
declare module '@alpinejs/csp' {
  import Alpine from 'alpinejs'
  export default Alpine
}
