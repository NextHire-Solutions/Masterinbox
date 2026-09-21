/*
 * Lets a plain `node scripts/*.mjs` (and `node --test`) import application
 * modules that use the `@/…` path alias and extensionless TypeScript imports.
 *
 * Next resolves `@/x` to `./x` through tsconfig `paths`; Node knows nothing
 * about that and fails with ERR_MODULE_NOT_FOUND. Rather than fork the app
 * code into scripts — which is how a test starts silently checking something
 * other than what ships — this teaches Node the same single rule.
 *
 * Same file as the OS's scripts/alias-hooks.mjs, with the alias root moved
 * from src/ to the project root, which is where this app keeps its code.
 *
 * Used as: node --import ./scripts/alias-hooks.mjs scripts/whatever.mjs
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-resolver.mjs", pathToFileURL("./scripts/"));
