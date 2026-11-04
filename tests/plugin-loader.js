import { registerHooks } from "node:module"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opencode/plugin") {
      return {
        url: new URL("./opencode-plugin-test-shim.js", import.meta.url).href,
        shortCircuit: true,
      }
    }
    return nextResolve(specifier, context)
  },
})
