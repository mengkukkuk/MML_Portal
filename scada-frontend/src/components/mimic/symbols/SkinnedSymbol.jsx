import CustomSymbol from './CustomSymbol'
import { isSkinnable, skinAssetId } from '../symbolSkin'
import { stateColor } from '../tagStatus'
import s from './symbols.module.css'

/**
 * SkinnedSymbol — any drawn symbol, shown as the picture an admin chose for it.
 *
 * It borrows CustomSymbol for the parts an uploaded picture needs and cannot
 * supply itself: the frame that carries status (an <image> is opaque to CSS, so
 * it will not take var(--warn) the way a drawn body does), the title, and the
 * pause-on-stop group. The node keeps its own type, so ports, the balloon and
 * the data binding are all resolved from the *original* symbol — only the
 * artwork is swapped.
 *
 * What a drawn symbol would have said with its shape — a pump's "running", a
 * breaker's "closed" — is printed as a caption instead, from the same tag state.
 * Dropping it would turn a safety-relevant fact into something an operator has
 * to infer from a photograph that never changes.
 */
export default function SkinnedSymbol({ node, def, tag }) {
  const skinDef = { ...def, asset_id: skinAssetId(node), dynamics: [] }
  const reportsState = def?.binding === 'both' || def?.binding === 'discrete'
  const state = reportsState ? tag?.state : null

  return (
    <g>
      <CustomSymbol node={node} def={skinDef} tag={tag} />
      {state && (
        <text
          className={s.labelDim}
          x={node.w / 2}
          y={node.h + 31}
          textAnchor="middle"
          style={{ fill: stateColor(state) ?? undefined }}
          transform={node.rot ? `rotate(${-node.rot} ${node.w / 2} ${node.h / 2})` : undefined}
        >
          {state}
        </text>
      )}
    </g>
  )
}

/**
 * The component that draws this node: its skin if it has one and its type can
 * take one, otherwise the symbol's own drawing. One decision, shared by the
 * canvas and the binding dialog's preview, so the preview cannot show a symbol
 * the sheet will not.
 */
export function rendererFor(node, def) {
  return skinAssetId(node) != null && isSkinnable(def) ? SkinnedSymbol : def.Component
}
