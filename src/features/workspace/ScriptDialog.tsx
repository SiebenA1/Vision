import { useEffect, useRef, type ReactNode } from 'react';

export function ScriptDialog({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  return <dialog ref={dialog} className="core-modal script-dialog" aria-label="脚本编辑" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="core-modal-heading"><h2>脚本编辑</h2><button onClick={onClose}>关闭</button></div>
    {children}
  </dialog>;
}
