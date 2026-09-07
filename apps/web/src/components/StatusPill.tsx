import { CheckCircle2, CircleDot, LoaderCircle, XCircle } from 'lucide-react';
import type { RunStatus } from '../../../../src/types';
import { STATUS_LABELS, STATUS_TONES } from '../lib/station';

function statusIcon(status: RunStatus) {
  if (status === 'running') return <LoaderCircle size={14} className="spin" />;
  if (status === 'completed') return <CheckCircle2 size={14} />;
  if (status === 'failed' || status === 'cancelled' || status === 'interrupted')
    return <XCircle size={14} />;
  return <CircleDot size={14} />;
}

export function StatusPill({ status }: { status: RunStatus }) {
  return (
    <span className={`status-pill ${STATUS_TONES[status]}`}>
      {statusIcon(status)}
      {STATUS_LABELS[status]}
    </span>
  );
}
