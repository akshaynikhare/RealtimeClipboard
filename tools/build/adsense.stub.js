/**
 * The desktop and VS Code stand-in for ui/features/adsense.js.
 *
 * tools/build/build.mjs resolves the real module here for `--desktop`, so the
 * AdSense identifiers are ABSENT from the installer rather than merely blocked
 * by its CSP. Google forbids ads in software applications and enforces at the
 * account level; "cannot be shipped" is a stronger guarantee than "cannot be
 * loaded". docs/decisions/0001, asserted by tools/check/desktop-check.mjs.
 *
 * `adNetwork()` never returns "adsense" on those surfaces, so this is dead code
 * that exists to make the bundle provably clean.
 */
export function mount({ settle }) { settle(false); }
