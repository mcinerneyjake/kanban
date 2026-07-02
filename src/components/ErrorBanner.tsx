type Props = {
  message: string
  onDismiss: () => void
}

// Dismissable error banner shared by App and Dashboard: click anywhere on it to
// clear the error. Extracted so the dismiss UX / markup / ARIA lives in one
// place (e.g. adding a ✕ or role="alert" later) instead of drifting across copies.
export default function ErrorBanner({ message, onDismiss }: Props) {
  return (
    <div className="error" onClick={onDismiss}>
      {message} — click to dismiss
    </div>
  );
}
