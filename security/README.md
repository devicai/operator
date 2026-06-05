# Sandbox seccomp hardening

Each sandbox runs under a seccomp profile selected by
`runtime.docker.hardening.seccompProfile`:

| Value          | Effect                                                                 |
| -------------- | ---------------------------------------------------------------------- |
| `default`      | The Docker daemon's built-in profile (default-deny allowlist). Strong. |
| `unconfined`   | No syscall filtering. **Do not use** for untrusted code.               |
| `<path>.json`  | A custom profile; its JSON is read and passed inline to the daemon.    |

The default profile is **default-deny** and, combined with `CapDrop: ALL`,
already blocks the capability-gated syscalls used by most container escapes
(`mount`, `bpf`, `ptrace`, `perf_event_open`, namespace `clone`/`unshare`,
`pivot_root`, `keyctl`, …). The notable syscall it still permits is
**`io_uring`**, a recurring local-privilege-escalation surface.

## Recommended residual mitigation: disable io_uring on the host

The robust, low-risk way to remove the io_uring surface is a host sysctl
(Linux ≥ 6.6) — it does not require hand-authoring a seccomp profile and cannot
break in-container workloads:

```sh
# Disable io_uring for all unprivileged processes, persistently
echo 'kernel.io_uring_disabled = 2' | sudo tee /etc/sysctl.d/99-io_uring.conf
sudo sysctl --system
```

`2` disables `io_uring_setup` entirely; `1` keeps it only for processes with
`CAP_SYS_ADMIN` (which sandboxes do not have, since caps are dropped).

## Optional: a custom hardened profile

If you prefer a seccomp profile over the sysctl, derive one from the daemon's
default rather than writing it from scratch (so you do not accidentally remove a
syscall that `apt`/`npm`/`pip` need):

1. Take Docker's published default profile
   (`https://github.com/moby/moby/blob/master/profiles/seccomp/default.json`).
2. Remove `io_uring_setup`, `io_uring_enter`, `io_uring_register` (and, if your
   kernel exposes it without a sysctl guard, `userfaultfd`) from the `names`
   arrays.
3. Drop it in this directory and point config at it:

   ```yaml
   runtime:
     docker:
       hardening:
         seccompProfile: security/seccomp-hardened.json
   ```

The path is resolved relative to the process working directory and its JSON is
validated at startup; a missing or malformed file falls back to the daemon
default with a warning (it never silently disables filtering).

> Always validate a custom profile against your real workloads before enabling
> it in production — a missing syscall surfaces as an opaque `EPERM` at runtime.
