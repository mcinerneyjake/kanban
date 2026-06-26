type Props = {
  /** Extra classes for size/colour variants. */
  className?: string
}

// A small inline loading spinner. The visual (size, border, animation) lives in
// styles.css under `.spinner`; pass `className` to vary it per use site.
export default function Spinner({ className }: Props) {
  return <span className={className ? `spinner ${className}` : 'spinner'} aria-hidden="true" />;
}
