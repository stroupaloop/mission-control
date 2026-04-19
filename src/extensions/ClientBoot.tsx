'use client'

/**
 * ClientBoot — side-effect import of extensions/client.ts.
 *
 * Rendered once inside the root layout. The sole purpose is to ensure the
 * client module graph loads src/extensions/client.ts at boot, which in turn
 * runs panel + nav-item registration at module-load time.
 *
 * This component renders nothing. All the work happens in the imported module.
 */

import './client'

export function ClientBoot(): null {
  return null
}
