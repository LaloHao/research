export function PaperDetail({ id }: { id: string }): React.JSX.Element {
  return (
    <div className="center">
      <code>{id}</code>
    </div>
  )
}
