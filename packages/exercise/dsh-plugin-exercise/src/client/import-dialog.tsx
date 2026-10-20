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

export interface ImportDialogProps {
  open: boolean;
  defaultCourse?: string;
  onClose: () => void;
  onImported: (courseId: string, sheet: SheetView, warnings: string[]) => void;
  onToast: (msg: string) => void;
}

export function ImportDialog({ open, defaultCourse, onClose, onImported, onToast }: ImportDialogProps): JSX.Element | null {
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
      setError('课程标识不能为空（例如 physik-1）');
      return;
    }
    if (!file) {
      setError('先选一份 PDF（或直接把文件拖进来）');
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
        w.length ? `已导入：${r.sheet.problems.length} 题（有 ${w.length} 条提示）` : `已导入：${r.sheet.problems.length} 题`,
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
        <h2>导入 Übungsblatt</h2>
        <p>PDF 会抽出文字，**由 LLM 拆成题目**（识别不了就退回规则分块）。公式可在题干里用 $...$ 补。</p>

        <div className="lec-field">
          <div className="lec-label">
            课程标识<span className="lec-req">*</span>（英文短名，会作为文件夹名）
          </div>
          <input className="lec-input" value={courseId} onChange={(e) => setCourseId(e.currentTarget.value)} placeholder="physik-1" />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <div className="lec-field" style={{ flex: 1 }}>
            <div className="lec-label">课程全名（可留空）</div>
            <input className="lec-input" value={courseTitle} onChange={(e) => setCourseTitle(e.currentTarget.value)} placeholder="Physik I" />
          </div>
          <div className="lec-field" style={{ width: 110 }}>
            <div className="lec-label">第几套</div>
            <input className="lec-input" value={number} onChange={(e) => setNumber(e.currentTarget.value)} placeholder="自动" />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <div className="lec-field" style={{ flex: 1 }}>
            <div className="lec-label">主题（可留空）</div>
            <input className="lec-input" value={title} onChange={(e) => setTitle(e.currentTarget.value)} placeholder="Mechanik" />
          </div>
          <div className="lec-field" style={{ width: 160 }}>
            <div className="lec-label">截止日</div>
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
            else if (f) setError('只接受 PDF 文件');
          }}
          onClick={() => document.getElementById('lec-pdf-input')?.click()}
        >
          {file ? `${file.name}（${Math.round(file.size / 1024)} KB）` : '把 PDF 拖到这里，或点击选择文件'}
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
            导入提示：
            <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="lec-modal-actions">
          <button type="button" className="lec-btn lec-btn-ghost" onClick={onClose} disabled={busy}>
            {warnings.length ? '完成' : '取消'}
          </button>
          <button type="button" className="lec-btn" onClick={() => void submit()} disabled={busy}>
            {busy ? '解析中…' : '导入'}
          </button>
        </div>
      </div>
    </div>
  );
}
