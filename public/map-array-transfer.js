import { api } from './account.js';
import { MAP_ARRAY_MAX_BYTES, formatMapArray } from './map-array.js';

export function initializeMapArrayTransfer({
  currentMap,
  transferDocument,
  replaceMap,
  mayReplace,
  isBusy,
  setBusy,
  feedback,
}) {
  const $ = (id) => document.getElementById(id);
  let fileEpoch = 0,
    fileLoading = false,
    exported = null,
    copyEpoch = 0;
  function importError(message = '') {
    $('array-import-error').textContent = message;
    if (message) $('array-import-error').scrollIntoView({ block: 'nearest' });
  }
  function exportStatus(message = '') {
    $('array-export-status').textContent = message;
    if (message) $('array-export-status').scrollIntoView({ block: 'nearest' });
  }
  function importControls() {
    $('confirm-array-import').disabled = fileLoading || isBusy();
  }
  function clearImport() {
    fileEpoch++;
    fileLoading = false;
    $('array-input').value = '';
    $('array-file').value = '';
    importError();
    importControls();
  }
  $('import-array').onclick = () => {
    if (isBusy()) return;
    clearImport();
    $('array-columns').value = currentMap()?.columns ?? $('columns').value;
    $('array-rows').value = currentMap()?.rows ?? $('rows').value;
    $('array-import-dialog').showModal();
    $('array-input').focus();
  };
  $('array-import-dialog').addEventListener('close', () => {
    if (!$('array-import-dialog').open) clearImport();
  });
  $('array-import-dialog').addEventListener('cancel', (event) => {
    if (isBusy()) event.preventDefault();
  });
  $('array-input').addEventListener('input', () => {
    fileEpoch++;
    fileLoading = false;
    importError();
    importControls();
  });
  $('array-file').onchange = async () => {
    const file = $('array-file').files[0];
    $('array-file').value = '';
    if (!file || isBusy()) return;
    const epoch = ++fileEpoch;
    fileLoading = true;
    importError();
    importControls();
    try {
      if (file.size > MAP_ARRAY_MAX_BYTES)
        throw new Error('맵 배열 파일은 64 KiB 이하로 선택하세요.');
      const text = await file.text();
      if (epoch === fileEpoch && $('array-import-dialog').open) $('array-input').value = text;
    } catch {
      if (epoch === fileEpoch && $('array-import-dialog').open)
        importError(
          file.size > MAP_ARRAY_MAX_BYTES
            ? '맵 배열 파일은 64 KiB 이하로 선택하세요.'
            : '파일을 읽지 못했습니다. 다시 선택하세요.',
        );
    } finally {
      if (epoch === fileEpoch) {
        fileLoading = false;
        importControls();
      }
    }
  };
  $('array-import-form').onsubmit = async (event) => {
    event.preventDefault();
    if (isBusy() || fileLoading) return;
    setBusy(true);
    for (const control of $('array-import-form').elements) control.disabled = true;
    $('array-import-form').setAttribute('aria-busy', 'true');
    $('confirm-array-import').textContent = '검사 중…';
    importError();
    try {
      const { map } = await api('/api/admin/maps/validate-array', {
        method: 'POST',
        body: JSON.stringify({
          columns: Number($('array-columns').value),
          rows: Number($('array-rows').value),
          source: $('array-input').value,
        }),
      });
      if (!mayReplace()) return;
      replaceMap(map);
      $('array-import-dialog').close();
      feedback('배열을 새 맵으로 가져왔습니다. 문제 위치와 게임 옵션을 확인한 뒤 저장·게시하세요.');
    } catch (error) {
      importError(error.message);
    } finally {
      for (const control of $('array-import-form').elements) control.disabled = false;
      $('array-import-form').setAttribute('aria-busy', 'false');
      $('confirm-array-import').textContent = '검사 후 가져오기';
      setBusy(false);
      importControls();
    }
  };
  function showExport() {
    if (!exported) return;
    copyEpoch++;
    $('copy-array').disabled = false;
    exportStatus();
    $('array-output').value = formatMapArray(exported, $('array-format').value);
  }
  $('export-array').onclick = async () => {
    if (isBusy() || !currentMap()) return;
    setBusy(true);
    try {
      exported = await transferDocument();
      $('array-format').value = 'array';
      $('array-export-info').textContent =
        `${exported.columns} × ${exported.rows} · ${exported.tiles.length}칸 · 왼쪽 위부터 행 순서`;
      showExport();
      $('array-export-dialog').showModal();
    } catch (error) {
      exported = null;
      feedback(`내보내기 실패: ${error.message}`, true);
    } finally {
      setBusy(false);
    }
  };
  $('array-format').onchange = showExport;
  $('array-export-dialog').addEventListener('close', () => {
    if ($('array-export-dialog').open) return;
    copyEpoch++;
    exported = null;
    $('array-output').value = '';
    exportStatus();
  });
  $('copy-array').onclick = async () => {
    if (!exported || !$('array-export-dialog').open) return;
    const text = $('array-output').value,
      epoch = ++copyEpoch;
    $('copy-array').disabled = true;
    exportStatus();
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (epoch === copyEpoch) exportStatus('맵 배열을 복사했습니다.');
    } catch {
      if (epoch === copyEpoch) {
        $('array-output').focus();
        $('array-output').select();
        exportStatus(
          '자동 복사를 사용할 수 없습니다. 선택된 배열을 Ctrl+C 또는 기기의 복사 메뉴로 복사하세요.',
        );
      }
    } finally {
      if (epoch === copyEpoch) $('copy-array').disabled = false;
    }
  };
  $('download-array').onclick = () => {
    if (!exported) return;
    const url = URL.createObjectURL(
      new Blob([$('array-output').value], { type: 'text/plain;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${exported.id}-${exported.columns}x${exported.rows}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    exportStatus('맵 배열을 파일로 내보냈습니다. 서버 저장 상태는 변경되지 않습니다.');
  };
}
