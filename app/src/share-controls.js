export function mountWnfsSharing(controls, sync, task, enabled, refresh) {
  if (!enabled) return () => {};
  const ja = document.documentElement.lang === 'ja';
  const label = (en, jp) => ja ? jp : en;
  const details = document.createElement('details');
  const heading = document.createElement('summary');
  heading.textContent = label('Snapshot sharing', 'スナップショットの共有');
  const input = document.createElement('textarea');
  input.maxLength = 16384;
  input.setAttribute('aria-label', label('Recipient or snapshot grant', '受信者情報または共有情報'));
  const output = document.createElement('textarea');
  output.readOnly = true;
  output.setAttribute('aria-label', label('Sharing output', '共有の出力'));
  const advice = document.createElement('p');
  advice.textContent = label(
    'Verify the key fingerprint with the recipient before adding them. Sync to issue new grants. Removing a recipient affects future snapshots.',
    '追加する前に相手の鍵の指紋を本人と照合してください。同期すると新しい共有情報が表示されます。失効は今後のスナップショットに適用されます。');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  details.append(heading, advice, input);
  const actions = document.createElement('div');
  function button(text, callback) {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = text;
    control.onclick = () => task(async () => {
      const result = await callback();
      status.textContent = result;
    });
    actions.append(control);
  }
  const parse = () => JSON.parse(input.value);
  button(label('Show my public key', '受信者情報を表示'), async () => {
    output.value = JSON.stringify(await sync.publicSnapshotRecipient(), null, 2);
    return label('Recipient information is ready.', '受信者情報を表示しました。');
  });
  button(label('Add recipient', '受信者を追加'), async () => {
    await sync.grantSnapshotRecipient(parse());
    return label('Recipient added for the next sync.', '次の同期の受信者を追加しました。');
  });
  button(label('Revoke for future snapshots', '次回以降の共有を失効'), async () => {
    await sync.revokeSnapshotRecipient(parse().id);
    return label('Recipient removed for future snapshots.', '今後のスナップショットから受信者を除外しました。');
  });
  button(label('Restore shared snapshot', '共有スナップショットを復元'), async () => {
    const value = parse();
    const grant = Array.isArray(value) && value.length === 1 ? value[0] : value;
    const result = await sync.restoreSharedSnapshot(grant);
    await refresh();
    return label('Shared folder: ', '復元した共有フォルダ ') + result.folder;
  });
  details.append(actions, output, status);
  controls.after(details);
  return snapshot => {
    if (Array.isArray(snapshot?.grants)) output.value = JSON.stringify(snapshot.grants, null, 2);
  };
}
