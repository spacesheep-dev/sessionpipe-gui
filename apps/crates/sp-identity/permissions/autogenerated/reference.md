## Default Permission

The signer, for the bundled main window only (capabilities/identity.json): read this device's key and grant, make the key, sign a checked command, approve a pairing, forget. Every command also checks the calling webview's label and origin.

#### This default permission set includes the following:

- `allow-status`
- `allow-key`
- `allow-sign`
- `allow-pair`
- `allow-forget`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`sp-identity:allow-forget`

</td>
<td>

Enables the forget command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`sp-identity:deny-forget`

</td>
<td>

Denies the forget command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`sp-identity:allow-key`

</td>
<td>

Enables the key command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`sp-identity:deny-key`

</td>
<td>

Denies the key command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`sp-identity:allow-pair`

</td>
<td>

Enables the pair command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`sp-identity:deny-pair`

</td>
<td>

Denies the pair command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`sp-identity:allow-sign`

</td>
<td>

Enables the sign command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`sp-identity:deny-sign`

</td>
<td>

Denies the sign command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`sp-identity:allow-status`

</td>
<td>

Enables the status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`sp-identity:deny-status`

</td>
<td>

Denies the status command without any pre-configured scope.

</td>
</tr>
</table>
