// SPDX-License-Identifier: Apache-2.0
// The native signer's hardware half (NATIVE-SPEC §5.5, arch-identity §6.1): CryptoKit's
// Secure Enclave P-256 keys and the login keychain, called from Rust through a C ABI
// (@_cdecl). Built by build.rs with `swiftc -emit-library -static`; no crate dependency.
//
// Status codes every call returns: 0 ok, 1 cancelled, 2 lockout, 3 unavailable,
// 4 failed, 5 interaction not allowed, 6 not found, 7 buffer too small.
import CryptoKit
import Foundation
import LocalAuthentication
import Security

private let OK: Int32 = 0
private let CANCELLED: Int32 = 1
private let LOCKOUT: Int32 = 2
private let UNAVAILABLE: Int32 = 3
private let FAILED: Int32 = 4
private let NO_INTERACTION: Int32 = 5
private let NOT_FOUND: Int32 = 6
private let TOO_SMALL: Int32 = 7

private func copyOut(_ d: Data, _ out: UnsafeMutablePointer<UInt8>, _ cap: Int, _ len: UnsafeMutablePointer<Int>) -> Int32 {
  len.pointee = d.count
  if d.count > cap { return TOO_SMALL }
  d.copyBytes(to: out, count: d.count)
  return OK
}

private func code(of error: Error) -> Int32 {
  if let la = error as? LAError {
    switch la.code {
    case .userCancel, .appCancel, .systemCancel, .userFallback: return CANCELLED
    case .biometryLockout: return LOCKOUT
    case .notInteractive: return NO_INTERACTION
    case .biometryNotAvailable, .passcodeNotSet, .biometryNotEnrolled: return UNAVAILABLE
    default: return FAILED
    }
  }
  let ns = error as NSError
  // errSecInteractionNotAllowed: the Mac is locked, so a WhenUnlocked key can't be made or used.
  if ns.domain == NSOSStatusErrorDomain && ns.code == Int(errSecInteractionNotAllowed) { return NO_INTERACTION }
  if ns.domain == LAErrorDomain {
    switch ns.code {
    case LAError.userCancel.rawValue, LAError.appCancel.rawValue, LAError.systemCancel.rawValue: return CANCELLED
    case LAError.biometryLockout.rawValue: return LOCKOUT
    case LAError.notInteractive.rawValue: return NO_INTERACTION
    default: return FAILED
    }
  }
  return FAILED
}

private func accessControl(presence: Bool) -> SecAccessControl? {
  // .userPresence allows Touch ID, the login password or an unlocked Watch, and survives a
  // new finger (unlike .biometryCurrentSet, which would wipe the key).
  let flags: SecAccessControlCreateFlags = presence ? [.privateKeyUsage, .userPresence] : [.privateKeyUsage]
  return SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, flags, nil)
}

/// Can this device hold a device key? The gate is a real attempt to make a key that needs
/// the person (NATIVE-SPEC §5.4): never `SecureEnclave.isAvailable` alone, because the iOS
/// simulator reports an enclave and then refuses every presence check. The key made here
/// is never stored and is gone when this returns.
@_cdecl("spid_available")
public func spid_available() -> Int32 {
  #if targetEnvironment(simulator)
    return 0
  #else
    guard SecureEnclave.isAvailable, let ac = accessControl(presence: true) else { return 0 }
    return (try? SecureEnclave.P256.Signing.PrivateKey(accessControl: ac)) != nil ? 1 : 0
  #endif
}

/// A new Secure Enclave key. `presence` 1: every signature needs the person (the device
/// key); 0: none (the day key, which the device key's grant vouches for). Writes the key's
/// blob (only this Mac's enclave can use it) and its SPKI (DER).
@_cdecl("spid_make")
public func spid_make(
  _ presence: Int32,
  _ blob: UnsafeMutablePointer<UInt8>, _ blobCap: Int, _ blobLen: UnsafeMutablePointer<Int>,
  _ spki: UnsafeMutablePointer<UInt8>, _ spkiCap: Int, _ spkiLen: UnsafeMutablePointer<Int>
) -> Int32 {
  guard let ac = accessControl(presence: presence != 0) else { return FAILED }
  do {
    let k = try SecureEnclave.P256.Signing.PrivateKey(accessControl: ac)
    let s = copyOut(k.dataRepresentation, blob, blobCap, blobLen)
    if s != OK { return s }
    return copyOut(k.publicKey.derRepresentation, spki, spkiCap, spkiLen)
  } catch {
    return code(of: error)
  }
}

/// One ECDSA P-256 / SHA-256 signature over `msg` with the key `blob`, raw r‖s (64 bytes).
/// A fresh LAContext per call, so a presence key asks every time (`uv: each-use`).
/// `reason` (UTF-8, NUL-terminated) is the line macOS shows: "“sessionpipe” is trying to
/// <reason>". `interactive` 0 forbids any UI: a presence key then fails with code 5
/// instead of prompting (tests, and the day key, which needs no person).
@_cdecl("spid_sign")
public func spid_sign(
  _ blob: UnsafePointer<UInt8>, _ blobLen: Int,
  _ msg: UnsafePointer<UInt8>, _ msgLen: Int,
  _ reason: UnsafePointer<CChar>?, _ interactive: Int32,
  _ sig: UnsafeMutablePointer<UInt8>
) -> Int32 {
  let ctx = LAContext()
  if let r = reason { ctx.localizedReason = String(cString: r) }
  ctx.interactionNotAllowed = interactive == 0
  do {
    let k = try SecureEnclave.P256.Signing.PrivateKey(
      dataRepresentation: Data(bytes: blob, count: blobLen), authenticationContext: ctx)
    let s = try k.signature(for: Data(bytes: msg, count: msgLen)).rawRepresentation
    guard s.count == 64 else { return FAILED }
    s.copyBytes(to: sig, count: 64)
    return OK
  } catch {
    return code(of: error)
  }
}

/// Does `sig` (r‖s) verify over `msg` for the SPKI? For tests: the daemon verifies with
/// WebCrypto, and this is the same math.
@_cdecl("spid_verify")
public func spid_verify(
  _ spki: UnsafePointer<UInt8>, _ spkiLen: Int,
  _ msg: UnsafePointer<UInt8>, _ msgLen: Int,
  _ sig: UnsafePointer<UInt8>
) -> Int32 {
  guard let pub = try? P256.Signing.PublicKey(derRepresentation: Data(bytes: spki, count: spkiLen)),
    let s = try? P256.Signing.ECDSASignature(rawRepresentation: Data(bytes: sig, count: 64))
  else { return 0 }
  return pub.isValidSignature(s, for: Data(bytes: msg, count: msgLen)) ? 1 : 0
}

/// `n` random bytes from the system's CSPRNG (a command's nonce).
@_cdecl("spid_random")
public func spid_random(_ out: UnsafeMutablePointer<UInt8>, _ n: Int) -> Int32 {
  SecRandomCopyBytes(kSecRandomDefault, n, out) == errSecSuccess ? OK : FAILED
}

// --- the login keychain (no provisioning profile needed; the default ACL trusts only the
// app that made the item) ---------------------------------------------------------------

private func query(_ service: UnsafePointer<CChar>, _ account: UnsafePointer<CChar>) -> [String: Any] {
  [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: String(cString: service),
    kSecAttrAccount as String: String(cString: account),
    kSecUseDataProtectionKeychain as String: false,
  ]
}

private func kcStatus(_ s: OSStatus) -> Int32 {
  switch s {
  case errSecSuccess: return OK
  case errSecItemNotFound: return NOT_FOUND
  case errSecUserCanceled, errSecAuthFailed: return CANCELLED
  case errSecInteractionNotAllowed: return NO_INTERACTION
  default: return FAILED
  }
}

@_cdecl("spid_kc_set")
public func spid_kc_set(
  _ service: UnsafePointer<CChar>, _ account: UnsafePointer<CChar>,
  _ data: UnsafePointer<UInt8>, _ len: Int
) -> Int32 {
  let q = query(service, account)
  SecItemDelete(q as CFDictionary)
  var add = q
  add[kSecValueData as String] = Data(bytes: data, count: len)
  add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
  return kcStatus(SecItemAdd(add as CFDictionary, nil))
}

@_cdecl("spid_kc_get")
public func spid_kc_get(
  _ service: UnsafePointer<CChar>, _ account: UnsafePointer<CChar>,
  _ out: UnsafeMutablePointer<UInt8>, _ cap: Int, _ len: UnsafeMutablePointer<Int>
) -> Int32 {
  var q = query(service, account)
  q[kSecReturnData as String] = true
  q[kSecMatchLimit as String] = kSecMatchLimitOne
  var item: CFTypeRef?
  let s = kcStatus(SecItemCopyMatching(q as CFDictionary, &item))
  if s != OK { return s }
  guard let d = item as? Data else { return FAILED }
  return copyOut(d, out, cap, len)
}

@_cdecl("spid_kc_delete")
public func spid_kc_delete(_ service: UnsafePointer<CChar>, _ account: UnsafePointer<CChar>) -> Int32 {
  let s = kcStatus(SecItemDelete(query(service, account) as CFDictionary))
  return s == NOT_FOUND ? OK : s
}
