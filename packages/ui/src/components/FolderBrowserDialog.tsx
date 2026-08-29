/**
 * FolderBrowserDialog — daemon-backed Finder-style repo picker (ADR-026).
 * Read-only listing scoped to $HOME; git repos flagged with a badge.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Badge } from './ui/card';
import { Folder, FolderOpen, ChevronLeft, Check, GitBranch } from 'lucide-react';

export function FolderBrowserDialog({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (path: string) => void;
}): JSX.Element {
  const [path, setPath] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<Array<{ name: string; type: 'dir' | 'file'; isGit: boolean }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');

  useEffect(() => {
    if (!open || path !== null) return;
    void load('');
  }, [open, path]);

  async function load(p: string): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const r = await api.browseFs(p);
      setPath(r.path);
      setParent(r.parent);
      setEntries(r.entries.filter((e) => e.type === 'dir'));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogTitle>Choose a repository folder</DialogTitle>
        <DialogDescription>Scoped to your home directory. Git repos are marked.</DialogDescription>

        <div className="mt-3 flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={!parent} onClick={() => path && parent && load(parent)}>
            <ChevronLeft /> Up
          </Button>
          <span className="mono truncate text-xs text-muted" title={path ?? ''}>
            ~{path ? path.replace(/^\/Users\/[^/]+/, '') : ''}
          </span>
        </div>

        {loading && <p className="py-6 text-center text-xs text-dim">Loading…</p>}
        {error && <div className="error-banner">{error}</div>}
        {!loading && (
          <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-border bg-bg p-1">
            {entries.length === 0 && <p className="p-4 text-center text-xs text-dim">No folders here.</p>}
            {entries.map((e) => (
              <button
                key={e.name}
                onClick={() => load(`${path}/${e.name}`)}
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-body hover:bg-surface-hover"
              >
                {e.isGit ? (
                  <GitBranch className="h-4 w-4 shrink-0 text-accent" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0 text-muted" />
                )}
                <span className="flex-1 truncate">{e.name}</span>
                {e.isGit && <Badge variant="success">repo</Badge>}
              </button>
            ))}
          </div>
        )}

        <div className="mt-3 border-t border-border pt-3">
          <label className="text-xs text-muted">…or paste a path</label>
          <div className="mt-1 flex gap-2">
            <Input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="/Users/you/dev/my-repo"
              className="mono"
            />
            <Button
              variant="outline"
              onClick={() => manual.trim() && load(manual.trim())}
            >
              Go
            </Button>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!path}
            onClick={() => {
              onPick(path!);
              onClose();
            }}
          >
            <Check /> Use this folder
          </Button>
        </div>
        {/* keep unused icon import referenced for future tree mode */}
        <span hidden><FolderOpen /></span>
      </DialogContent>
    </Dialog>
  );
}
