import { describeError } from '../api';

export function ErrorBanner({ error, onDismiss }: { error: unknown; onDismiss(): void }) {
  return (
    <div className="banner" role="alert">
      <span>{describeError(error)}</span>
      <button type="button" className="danger" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
