// ============================================================
// client/import-dialog.tsx — 导入 Übungsblatt（PDF）
//
// 外观与 lecture 的表单一致（.lec-modal / .lec-field / .lec-input / .lec-drop）。
// 流程：选/拖 PDF → 填课程与截止日 → POST import。
//
// 导入侧现在**默认用 LLM 拆题**（用户反馈：LaTeX 排版的 PDF 文本用正则
// 基本切不准）。LLM 不可用时 host 会退回规则分块，界面把提示原样显示出来。
// ============================================================

import { useState } from 'react';
import { apiPost, fileToBase64, type SheetView } from './api.ts';
import { useT } from './i18n.ts';

export interface ImportDialogProps {
  open: boolean;
  defaultCourse?: string;
  onClose: () => void;
  onImported: (courseId: string, sheet: SheetView, warnings: string[]) => void;
  onToast: (msg: string) => void;
}

export function ImportDialog({ open, defaultCourse, onClose, onImported, onToast }: ImportDialogProps): JSX.Element | null {
  const t = useT();
  const [courseId, setCourseId] = useState(defaultCourse ?? '');
  const [courseTitle, setCourseTitle] = useState('');
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [number, setNumber] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [hot, setHot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    setError(null);
    setWarnings([]);
    const cid = courseId.trim();
    if (!cid) {
      setError(t('exercise.import.courseIdRequired'));
      return;
    }
    if (!file) {
      setError(t('exercise.import.fileRequired'));
      return;
    }
    setBusy(true);
    try {
      const pdfBase64 = await fileToBase64(file);
      const r = await apiPost<{ sheet: SheetView; warnings?: string[] }>('import', {
        course_id: cid,
        course_title: courseTitle.trim() || undefined,
        title: title.trim() || undefined,
        due: due.trim() || undefined,
        number: number.trim() ? Number(number.trim()) : undefined,
        filename: file.name,
        pdf_base64: pdfBase64,
      });
      const w = r.warnings ?? [];
      setWarnings(w);
      onImported(cid, r.sheet, w);
      onToast(
        w.length
          ? t('exercise.import.toast.doneWithWarnings', { n: r.sheet.problems.length, w: w.length })
          : t('exercise.import.toast.done', { n: r.sheet.problems.length }),
      );
      setBusy(false);
      if (!w.length) onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="lec-modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="lec-modal">
        <h2>{t('exercise.import.title')}</h2>
        <p>{t('exercise.import.lead')}</p>

        <div className="lec-field">
          <div className="lec-label">
            {t('exercise.import.courseIdLabel')}
            <span className="lec-req">*</span>
            {t('exercise.import.courseIdNote')}
          </div>
          <input className="lec-input" value={courseId} onChange={(e) => setCourseId(e.currentTarget.value)} placeholder="physik-1" />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <div className="lec-field" style={{ flex: 1 }}>
            <div className="lec-label">{t('exercise.import.courseTitleLabel')}</div>
            <input className="lec-input" value={courseTitle} onChange={(e) => setCourseTitle(e.currentTarget.value)} placeholder="Physik I" />
          </div>
          <div className="lec-field" style={{ width: 110 }}>
            <div className="lec-label">{t('exercise.import.numberLabel')}</div>
            <input
              className="lec-input"
              value={number}
              onChange={(e) => setNumber(e.currentTarget.value)}
              placeholder={t('exercise.import.numberPlaceholder')}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <div className="lec-field" style={{ flex: 1 }}>
            <div className="lec-label">{t('exercise.import.titleLabel')}</div>
            <input className="lec-input" value={title} onChange={(e) => setTitle(e.currentTarget.value)} placeholder="Mechanik" />
          </div>
          <div className="lec-field" style={{ width: 160 }}>
            <div className="lec-label">{t('exercise.import.dueLabel')}</div>
            <input className="lec-input" type="date" value={due} onChange={(e) => setDue(e.currentTarget.value)} />
          </div>
        </div>

        <div
          className="lec-drop"
          data-hot={hot ? '1' : '0'}
          onDragOver={(e) => {
            e.preventDefault();
            setHot(true);
          }}
          onDragLeave={() => setHot(false)}
          onDrop={(e) => {
            e.preventDefault();
            setHot(false);
            const f = e.dataTransfer.files?.[0];
            if (f && f.name.toLowerCase().endsWith('.pdf')) setFile(f);
            else if (f) setError(t('exercise.import.pdfOnly'));
          }}
          onClick={() => document.getElementById('lec-pdf-input')?.click()}
        >
          {file
            ? t('exercise.import.fileChosen', { name: file.name, size: Math.round(file.size / 1024) })
            : t('exercise.import.dropHint')}
        </div>
        <input
          id="lec-pdf-input"
          type="file"
          accept="application/pdf,.pdf"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.currentTarget.files?.[0] ?? null;
            if (f) setFile(f);
          }}
        />

        {error && <div className="lec-warn" style={{ marginTop: 10 }}>{error}</div>}
        {warnings.length > 0 && (
          <div className="lec-warnbox">
            {t('exercise.import.warnings')}
            <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="lec-modal-actions">
          <button type="button" className="lec-btn lec-btn-ghost" onClick={onClose} disabled={busy}>
            {warnings.length ? t('exercise.common.done') : t('exercise.common.cancel')}
          </button>
          <button type="button" className="lec-btn" onClick={() => void submit()} disabled={busy}>
            {busy ? t('exercise.import.parsing') : t('exercise.import.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
