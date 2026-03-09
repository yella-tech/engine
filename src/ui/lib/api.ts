export async function api(path: string, opts?: RequestInit) {
  const res = await fetch(path, opts)
  return res.json()
}
