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
  const recipientsLabel = document.createElement('label');
  recipientsLabel.htmlFor = 'wnfs-issued-recipient';
  recipientsLabel.textContent = label('Shared with', '共有先');
  const recipients = document.createElement('select');
  recipients.id = recipientsLabel.htmlFor;
  recipients.hidden = recipientsLabel.hidden = true;
  let grants = [];
  const showGrant = () => {
    const selected = grants[Number(recipients.value)];
    output.value = selected ? JSON.stringify(selected, null, 2) : '';
  };
  recipients.onchange = showGrant;
  const advice = document.createElement('p');
  advice.textContent = label(
    'Confirm the account DID and key fingerprint with the other person. Sync to issue new grants. Removing a recipient affects future snapshots.',
    '相手のアカウント DID と鍵の指紋を本人と照合してください。同期すると新しい共有情報が表示されます。失効は今後のスナップショットに適用されます。');
  const sender = document.createElement('input');
  sender.type = 'text';
  sender.maxLength = 132;
  sender.placeholder = label('Expected sender account DID', '共有元から確認したアカウント DID');
  sender.setAttribute('aria-label', sender.placeholder);
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  details.append(heading, advice, input, sender);
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
    const information = await sync.publicSnapshotRecipient();
    recipients.hidden = recipientsLabel.hidden = true;
    output.value = JSON.stringify(information, null, 2);
    return label('Recipient information is ready.', '受信者情報を表示しました。');
  });
  button(label('Add recipient', '受信者を追加'), async () => {
    await sync.grantSnapshotRecipient(parse());
    return label('Recipient added for the next sync.', '次の同期の受信者を追加しました。');
  });
  button(label('Revoke for future snapshots', '次回以降の共有を失効'), async () => {
    const value = parse();
    await sync.revokeSnapshotRecipient(value.publicKey?.id ?? value.id);
    return label('Recipient removed for future snapshots.', '今後のスナップショットから受信者を除外しました。');
  });
  button(label('Restore shared snapshot', '共有スナップショットを復元'), async () => {
    const value = parse();
    const grant = Array.isArray(value) && value.length === 1 ? value[0] : value;
    const result = await sync.restoreSharedSnapshot(grant, sender.value.trim());
    await refresh();
    return label('Shared folder: ', '復元した共有フォルダ ') + result.folder;
  });
  details.append(actions, recipientsLabel, recipients, output, status);
  controls.after(details);
  return snapshot => {
    if (!Array.isArray(snapshot?.grants)) return;
    grants = snapshot.grants;
    recipients.replaceChildren(...grants.map(({ recipient, grant }, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `${recipient} · ${grant.recipient}`;
      return option;
    }));
    recipients.hidden = recipientsLabel.hidden = grants.length === 0;
    showGrant();
    const needsProof = snapshot.unverifiedRecipients ?? [];
    const pending = snapshot.unpublishedRecipients ?? [];
    const warnings = [];
    if (needsProof.length) {
      warnings.push(label('Renew recipient information for ', '受信者情報の更新が必要です ') + needsProof.join(', '));
    }
    if (pending.length) {
      warnings.push(label('Share approval did not complete for ', '共有の承認を完了できませんでした ') + pending.join(', '));
    }
    status.textContent = warnings.join(' / ');
    if (warnings.length) details.open = true;
  };
}
