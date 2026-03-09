import { formatJson } from '../lib/format'

export function JsonBlock({ data }: { data: unknown }) {
  return <div class="json-block">{typeof data === 'string' ? data : formatJson(data)}</div>
}
