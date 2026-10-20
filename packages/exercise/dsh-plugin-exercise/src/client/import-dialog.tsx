// ============================================================
// client/import-dialog.tsx — 导入 Übungsblatt（PDF）
//
// 流程：选/拖 PDF → 填课程与截止日 → POST import → host 用 pdfjs 抽文本 + 拆题。
// 抽不出文本时（扫描版/纯公式）**不报错**，而是建一套空题集并把
// `needs_manual_text` 置真，界面提示"手补题干" —— 这比"导入失败"有用得多。
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
        w.length
          ? `已导入：${r.sheet.problems.length} 题（有 ${w.length} 条提示，见界面顶部）`
          : `已导入：${r.sheet.problems.length} 题`,
      );
      setBusy(false);
      // 有提示时留在弹层里让人读完；没提示直接关
      if (!w.length) onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="ex-modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ex-modal">
        <h2>导入 Übungsblatt</h2>
        <p>PDF 会抽出文字并按「Aufgabe 1 / 1.」拆题；公式建议自己在题干里用 $...$ 补。</p>

        <div className="ex-field">
          <label>课程标识（英文短名，会作为文件夹名）</label>
          <input className="ex-input" value={courseId} onChange={(e) => setCourseId(e.currentTarget.value)} placeholder="physik-1" />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <div className="ex-field" style={{ flex: 1 }}>
            <label>课程全名（可留空）</label>
            <input className="ex-input" value={courseTitle} onChange={(e) => setCourseTitle(e.currentTarget.value)} placeholder="Physik I" />
          </div>
          <div className="ex-field" style={{ width: 110 }}>
            <label>第几套</label>
            <input className="ex-input" value={number} onChange={(e) => setNumber(e.currentTarget.value)} placeholder="自动" />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <div className="ex-field" style={{ flex: 1 }}>
            <label>主题（可留空）</label>
            <input className="ex-input" value={title} onChange={(e) => setTitle(e.currentTarget.value)} placeholder="Mechanik" />
          </div>
          <div className="ex-field" style={{ width: 160 }}>
            <label>截止日</label>
            <input className="ex-input" type="date" value={due} onChange={(e) => setDue(e.currentTarget.value)} />
          </div>
        </div>

        <div
          className={hot ? 'ex-drop hot' : 'ex-drop'}
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
          onClick={() => document.getElementById('ex-pdf-input')?.click()}
        >
          {file ? `${file.name}（${Math.round(file.size / 1024)} KB）` : '把 PDF 拖到这里，或点击选择文件'}
        </div>
        <input
          id="ex-pdf-input"
          type="file"
          accept="application/pdf,.pdf"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.currentTarget.files?.[0] ?? null;
            if (f) setFile(f);
          }}
        />

        {error && <div className="ex-error" style={{ marginTop: 10 }}>{error}</div>}
        {warnings.length > 0 && (
          <div className="ex-warn-list">
            导入提示：
            <ul>
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="ex-modal-actions">
          <button type="button" className="ex-btn" onClick={onClose} disabled={busy}>
            {warnings.length ? '完成' : '取消'}
          </button>
          <button type="button" className="ex-btn ex-btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '解析中…' : '导入'}
          </button>
        </div>
      </div>
    </div>
  );
}
