type Props = {
  message: string
  onDismiss: () => void
}

export default function ErrorBanner({ message, onDismiss }: Props) {
  return (
    <div className="error" onClick={onDismiss}>
      {message} — click to dismiss
    </div>
  );
}
