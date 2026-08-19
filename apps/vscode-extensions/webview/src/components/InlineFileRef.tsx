import React from 'react';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { FileRef } from '../utils/fileRefs';

const fileName = (p: string) => p.split('/').pop() || p;

/** Clickable pill for a file path recognized inside an inline code span — opens the file (and range) in the editor. */
const InlineFileRef: React.FC<{ text: string; fileRef: FileRef }> = ({ text, fileRef }) => {
  const vscode = VSCodeAPI();
  const label =
    fileRef.line != null
      ? `${fileName(fileRef.path)}:L${fileRef.line}${fileRef.endLine && fileRef.endLine !== fileRef.line ? `-${fileRef.endLine}` : ''}`
      : fileName(fileRef.path);

  const open = () => {
    vscode.postMessage({
      type: MESSAGE_TYPES.OPEN_FILE_IN_EDITOR,
      path: fileRef.path,
      line: fileRef.line,
      endLine: fileRef.endLine,
    });
  };

  return (
    <button type='button' className='inline-file-ref' title={text} onClick={open}>
      {label}
    </button>
  );
};

export default InlineFileRef;
