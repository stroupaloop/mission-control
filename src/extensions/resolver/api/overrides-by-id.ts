import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { removeOverride } from '@/extensions/resolver/overrides'

/**
 * DELETE /api/resolver/overrides/:toolId
 *
 * Removes a single override entry from resolver-overrides.json.
 * Returns 404 if the file doesn't exist; 200 with updated file contents if successful.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ toolId: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const { toolId } = await params
  const decodedId = decodeURIComponent(toolId)

  if (!decodedId || !decodedId.trim()) {
    return NextResponse.json({ error: 'toolId is required' }, { status: 400 })
  }

  try {
    const updated = removeOverride(decodedId.trim())
    if (updated === null) {
      return NextResponse.json({ error: 'Overrides file does not exist' }, { status: 404 })
    }
    logger.info({ toolId: decodedId.trim() }, 'Resolver override removed')
    return NextResponse.json(updated)
  } catch (err: any) {
    logger.error({ err }, 'Resolver overrides DELETE failed')
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
