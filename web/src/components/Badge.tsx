export function Badge({ value }: { value: string }) {
  return <span className={`badge badge-${value}`}>{value.replace('_', ' ')}</span>;
}
