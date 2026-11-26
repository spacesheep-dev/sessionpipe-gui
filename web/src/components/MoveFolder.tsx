// SPDX-License-Identifier: Apache-2.0
// Owned by: web. "Move to folder…" searchable picker (⇧M) with inline create, plus a
// lightweight folder create / rename dialog for touch screens and the "New folder…" menu
// item. Mounted via MoveUnderHost in the shell, using the same dialog / sheet frames.
import {
  ARRANGEMENT_FOLDER_NAME_MAX,
  ARRANGEMENT_FOLDERS_MAX,
  type ArrangementFolder,
  LABEL_COLORS,
  LABEL_DEFAULT_NAMES,
  type LabelColor,
  type SessionKey,
} from "@shared/api";
import { sanitizeFolderName } from "@shared/arrangement";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { useAppState, useStore } from "../data/hooks";
import {
  arrange,
  createFolder,
  type FolderPromptRequest,
  type MoveFolderRequest,
  onFolderPrompt,
  onMoveFolder,
  renameFolder,
} from "../lib/arrange";
import { usePhoneLayout } from "../lib/device";
import { useFocusTrap } from "../lib/focus";
import { sessionTitle } from "../lib/format";
import { fuzzy } from "../lib/fuzzy";
import { calmNextCommit } from "../lib/motion";
import { usePath } from "../lib/router";
import "../styles/pick.css";
import "../styles/sidetree.css";

export function MoveFolderHost() {
  const [pickReq, setPickReq] = useState<MoveFolderRequest | null>(null);
  const [promptReq, setPromptReq] = useState<FolderPromptRequest | null>(null);
  useEffect(() => onMoveFolder(setPickReq), []);
  useEffect(() => onFolderPrompt(setPromptReq), []);
  useEffect(() => {
    const close = () => {
      setPickReq(null);
      setPromptReq(null);
    };
    window.addEventListener("popstate", close);
    return () => window.removeEventListener("popstate", close);
  }, []);
  if (!pickReq && !promptReq) return null;
  return (
    <MoveFolderOpen
      pickReq={pickReq}
      promptReq={promptReq}
      closePick={() => setPickReq(null)}
      closePrompt={() => setPromptReq(null)}
      closeAll={() => {
        setPickReq(null);
        setPromptReq(null);
      }}
    />
  );
}

function MoveFolderOpen({
  pickReq,
  promptReq,
  closePick,
  closePrompt,
  closeAll,
}: {
  pickReq: MoveFolderRequest | null;
  promptReq: FolderPromptRequest | null;
  closePick: () => void;
  closePrompt: () => void;
  closeAll: () => void;
}) {
  const path = usePath();
  const prevPath = useRef(path);
  useEffect(() => {
    if (prevPath.current === path) return;
    prevPath.current = path;
    closeAll();
  }, [path, closeAll]);
  return (
    <>
      {pickReq && (
        <FolderPicker key={pickReq.key} moving={pickReq.key} fromTree={!!pickReq.fromTree} onClose={closePick} />
      )}
      {promptReq && (
        <FolderPrompt
          key={`${promptReq.mode}:${promptReq.folderId ?? promptReq.moveSession ?? "new"}`}
          req={promptReq}
          onClose={closePrompt}
        />
      )}
    </>
  );
}

type FolderChoice =
  | { kind: "folder"; folder: ArrangementFolder; current: boolean }
  | { kind: "remove" }
  | { kind: "create"; name: string };

/** Matches folders to `q`, appending Remove from folder (if currently in one) and an
 *  inline Create option when `q` is a valid non-duplicate name and under the cap. */
export function folderPickerChoices(
  folders: readonly ArrangementFolder[],
  curFolder: string | undefined,
  q: string,
): FolderChoice[] {
  const clean = sanitizeFolderName(q);
  const matched: ArrangementFolder[] = !clean
    ? [...folders]
    : folders
        .map((f, i) => ({ f, i, score: fuzzy(clean, f.name)?.score ?? -1 }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .map((x) => x.f);
  const out: FolderChoice[] = matched.map((folder) => ({
    kind: "folder",
    folder,
    current: folder.id === curFolder,
  }));
  if (curFolder && (!clean || "remove from folder".includes(clean.toLowerCase()))) {
    out.push({ kind: "remove" });
  }
  const exact = clean && folders.some((f) => f.name.toLowerCase() === clean.toLowerCase());
  if (clean && !exact && clean.length <= ARRANGEMENT_FOLDER_NAME_MAX && folders.length < ARRANGEMENT_FOLDERS_MAX) {
    out.push({ kind: "create", name: clean });
  }
  return out;
}

function FolderGlyph() {
  return (
    <svg
      className="stree-folder-glyph"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
    </svg>
  );
}

function FolderPicker({ moving, fromTree, onClose }: { moving: SessionKey; fromTree: boolean; onClose: () => void }) {
  const store = useStore();
  const state = useAppState();
  const ref = useRef<HTMLDivElement>(null);
  const phone = usePhoneLayout();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const folders = state.arrangement.folders ?? [];
  const curFolder = state.arrangement.inFolder?.[moving];
  const choices = useMemo(() => folderPickerChoices(folders, curFolder, q), [folders, curFolder, q]);
  const choice = Math.min(at, Math.max(0, choices.length - 1));
  const s = state.sessions.get(moving);
  const id = useId();
  useFocusTrap(ref, Boolean(s), { onClose, initial: "input" });
  useEffect(() => {
    if (!s) onClose();
  }, [s, onClose]);
  useEffect(() => {
    ref.current?.querySelector(`[data-pick="${choice}"]`)?.scrollIntoView({ block: "nearest" });
  }, [choice]);

  const take = (item: FolderChoice | undefined, viaKey = false) => {
    if (!item) return;
    onClose();
    if (viaKey && fromTree) calmNextCommit();
    const src = fromTree ? { source: "picker" as const } : undefined;
    if (item.kind === "folder") {
      if (!item.current) arrange(store, moving, { kind: "folder", folderId: item.folder.id }, src);
    } else if (item.kind === "remove") {
      arrange(store, moving, { kind: "unfolder" }, src);
    } else {
      createFolder(store, item.name, { moveSession: moving, ...(src ?? {}) });
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") setAt(Math.min(choice + 1, choices.length - 1));
    else if (e.key === "ArrowUp") setAt(Math.max(choice - 1, 0));
    else if (e.key === "Enter") take(choices[choice], true);
    else if (e.key === "Escape") onClose();
    else return;
    e.preventDefault();
  };

  if (!s) return null;
  const title = (
    <h2 className={phone ? "menu-sheet-title" : "confirm-title"} id={`${id}-title`}>
      Move to folder…
    </h2>
  );
  return (
    <>
      <button
        type="button"
        className={phone ? "menu-scrim" : "menu-scrim menu-scrim--dialog"}
        aria-label="Close"
        onClick={onClose}
        data-dismiss
      />
      <div
        className={phone ? "menu-sheet pick-sheet" : "confirm pick-dialog"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-what`}
        ref={ref}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== "Tab" && e.key !== "Escape") e.stopPropagation();
        }}
      >
        {phone && <span className="menu-grab" aria-hidden="true" />}
        {phone ? <div className="menu-sheet-head">{title}</div> : title}
        <p className="pick-what" id={`${id}-what`}>
          Choose a folder for “{sessionTitle(s)}”, or type a name to create one.
        </p>
        <input
          className="field pick-field"
          type="text"
          value={q}
          maxLength={ARRANGEMENT_FOLDER_NAME_MAX}
          placeholder="Find or create a folder"
          aria-label="Find or create a folder"
          role="combobox"
          aria-expanded={choices.length > 0}
          aria-controls={choices.length > 0 ? `${id}-list` : undefined}
          aria-activedescendant={choices.length ? `${id}-opt-${choice}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setQ(e.target.value);
            setAt(0);
          }}
          onKeyDown={onKey}
        />
        {choices.length === 0 ? (
          <p className="pick-list pick-none" id={`${id}-list`} role="status">
            Type a name to create a new folder
          </p>
        ) : (
          <div className="pick-list" role="listbox" id={`${id}-list`} aria-label="Folders">
            {choices.map((item, i) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input above owns arrow and Enter keys
              <div
                key={item.kind === "folder" ? item.folder.id : item.kind}
                id={`${id}-opt-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === choice}
                className="pick-row"
                data-pick={i}
                onPointerMove={() => i !== choice && setAt(i)}
                onClick={() => take(item)}
              >
                {item.kind === "folder" && (
                  <>
                    <FolderGlyph />
                    {item.folder.color && (
                      <span
                        className={`stree-folder-dot label-dot label-dot--${item.folder.color}`}
                        aria-hidden="true"
                      />
                    )}
                    <span className="pick-title" dir="auto">
                      {item.folder.name}
                    </span>
                    {item.current && <span className="pick-where">Current</span>}
                  </>
                )}
                {item.kind === "remove" && <span className="pick-title">Remove from folder</span>}
                {item.kind === "create" && <span className="pick-title">Create “{item.name}”</span>}
              </div>
            ))}
          </div>
        )}
        <div className={phone ? "menu-sheet-group" : "confirm-actions"}>
          <button type="button" className={phone ? "menu-sheet-item menu-sheet-cancel" : "btn"} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

function FolderPrompt({ req, onClose }: { req: FolderPromptRequest; onClose: () => void }) {
  const store = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const phone = usePhoneLayout();
  const [name, setName] = useState(req.initialName ?? "");
  const [color, setColor] = useState<LabelColor | null>(null);
  const id = useId();
  useFocusTrap(ref, true, { onClose, initial: "input" });
  useEffect(() => {
    if (req.mode === "rename") inputRef.current?.select();
  }, [req.mode]);

  const clean = sanitizeFolderName(name);
  const valid = clean.length >= 1 && clean.length <= ARRANGEMENT_FOLDER_NAME_MAX;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onClose();
    if (req.mode === "rename" && req.folderId) {
      renameFolder(store, req.folderId, clean);
    } else {
      createFolder(store, clean, {
        ...(color ? { color } : {}),
        ...(req.moveSession ? { moveSession: req.moveSession } : {}),
        ...(req.fromTree ? { source: "picker" } : {}),
      });
    }
  };

  const heading = req.mode === "rename" ? "Rename folder" : "New folder";
  const title = (
    <h2 className={phone ? "menu-sheet-title" : "confirm-title"} id={`${id}-title`}>
      {heading}
    </h2>
  );
  return (
    <>
      <button
        type="button"
        className={phone ? "menu-scrim" : "menu-scrim menu-scrim--dialog"}
        aria-label="Close"
        onClick={onClose}
        data-dismiss
      />
      <div
        className={phone ? "menu-sheet pick-sheet" : "confirm pick-dialog"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        ref={ref}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== "Tab" && e.key !== "Escape") e.stopPropagation();
        }}
      >
        {phone && <span className="menu-grab" aria-hidden="true" />}
        {phone ? <div className="menu-sheet-head">{title}</div> : title}
        <form onSubmit={submit} className="stree-folder-form">
          <input
            ref={inputRef}
            className="field pick-field"
            type="text"
            value={name}
            maxLength={ARRANGEMENT_FOLDER_NAME_MAX}
            placeholder="Folder name"
            aria-label="Folder name"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
          {req.mode === "create" && (
            <fieldset className="stree-color-row">
              <legend className="sr-only">Folder color</legend>
              <button
                type="button"
                aria-pressed={color === null}
                aria-label="No color"
                className={`stree-color-opt${color === null ? " stree-color-opt--on" : ""}`}
                onClick={() => setColor(null)}
              >
                <span className="stree-color-none" aria-hidden="true" />
              </button>
              {LABEL_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={color === c}
                  aria-label={LABEL_DEFAULT_NAMES[c]}
                  className={`stree-color-opt${color === c ? " stree-color-opt--on" : ""}`}
                  onClick={() => setColor(c)}
                >
                  <span className={`label-dot label-dot--${c}`} aria-hidden="true" />
                </button>
              ))}
            </fieldset>
          )}
          <div className={phone ? "menu-sheet-group" : "confirm-actions"}>
            <button type="button" className={phone ? "menu-sheet-item menu-sheet-cancel" : "btn"} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={phone ? "menu-sheet-item" : "btn btn--primary"} disabled={!valid}>
              {req.mode === "rename" ? "Save" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
