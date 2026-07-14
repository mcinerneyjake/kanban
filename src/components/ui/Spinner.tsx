type Props = {
  className?: string
}

export default function Spinner({ className }: Props) {
  return <span className={className ? `spinner ${className}` : 'spinner'} aria-hidden="true" />;
}
