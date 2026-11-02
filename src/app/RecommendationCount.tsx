export function RecommendationCount({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="text-caption text-muted">
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">
        {count === 1 ? "1 recommended plugin" : `${count} recommended plugins`}
      </span>
    </span>
  );
}
