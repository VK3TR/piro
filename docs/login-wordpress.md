# Members' login through a WordPress site

This guide sets up the login described in the README's
[Access from the internet with a login](../README.md#access-from-the-internet-with-a-login).
Members sign in with their club web site account. It uses:

- **WordPress** with the
  [OpenID Connect Server](https://wordpress.org/plugins/openid-connect-server/)
  plugin (written for version 2.0.3). Ultimate Member can stay as it is.
- **oauth2-proxy** on the Pi. It sends people to the club web site to log
  in, and passes only signed-in members to PiRO.
- **Caddy** on the Pi. It gives the Pi an HTTPS address with a free
  certificate. The microphone needs HTTPS.

```
phone --HTTPS--> Caddy :443 --> oauth2-proxy 127.0.0.1:4180 --> PiRO 127.0.0.1:8080
                                      |
                                      +--> club web site (login)
```

The examples use `club.example.org` for the WordPress site and
`radio.example.org` for PiRO. Use your own names.

Nothing here has been tried with a real club site yet. Test each step.

## 1. WordPress

### Install the plugin and give it keys

Install **OpenID Connect Server** from Plugins > Add New.

The plugin signs logins with an RSA key. Make one on any computer:

```bash
openssl genrsa -out oidc.key 4096
```

```bash
openssl rsa -in oidc.key -pubout -out oidc-public.key
```

Put both files on the web server outside the web root, where no web page
can serve them. Then add these lines to `wp-config.php`, above the line
"That's all, stop editing!". Use the path where you put the files:

```php
define( 'OIDC_PRIVATE_KEY', file_get_contents( '/home/club/oidc/oidc.key' ) );
define( 'OIDC_PUBLIC_KEY', file_get_contents( '/home/club/oidc/oidc-public.key' ) );
```

### Add the PiRO client

Copy [`deploy/wordpress/piro-login.php`](../deploy/wordpress/piro-login.php)
to `wp-content/mu-plugins/` on the WordPress site. Make the folder if it
isn't there. WordPress runs files there without activating them. Edit
the lines marked CHANGE:

- **`secret`**: a long random string. oauth2-proxy uses the same one.
  Make one with `openssl rand -hex 32`.
- **`redirect_uri`**: `https://` + PiRO's address + `/oauth2/callback`.
- **The member role.** The file gives the `use_piro` capability to the
  `administrator` role and to one member role. Put in your member role's
  slug. Ultimate Member lists its roles under Ultimate Member > User Roles.

The file does four things. Each one fixes a plugin default that would
stop members logging in:

| Plugin default | Problem | The file |
|---|---|---|
| Only users who can `edit_posts` may log in | Members (subscriber-like roles) are refused: "You don't have permission to use OpenID Connect." | Allows users with `use_piro`, and gives it to the member role |
| Asks "Do you want to log in to PiRO?" and remembers the answer for 7 days | An extra step each week | `requires_consent => false` |
| Sends no email address | oauth2-proxy refuses a login without one | Adds the member's email to the login |
| Offers only the `openid` and `profile` scopes | oauth2-proxy asks for `email` too unless told not to, and the plugin refuses it | The oauth2-proxy config asks for `openid profile` only |

### Check it

Open `https://club.example.org/.well-known/openid-configuration` in a
browser. It should show JSON with an `issuer` of
`https://club.example.org/`. If it shows a page instead, check the
plugin is active.

### Who can log in

Anyone who can log in to the club web site with a role that has
`use_piro` can use the radio. Check:

- **Registration.** If anyone can register and gets the member role
  straight away, anyone on the internet can use the radio. In Ultimate
  Member, make new registrations need admin approval, or give `use_piro`
  only to a role you give out by hand. Test that a pending account can't
  get in.
- **Ultimate Member's login page.** When a member isn't logged in, the
  plugin sends them to the WordPress login (`wp-login.php`) with a return
  address. If Ultimate Member replaces the WordPress login page, check
  that a member comes back to PiRO after logging in. If they end up on
  their profile page instead, look at the member role's "after login"
  setting in Ultimate Member and at any setting that turns off the
  WordPress login page. The plugin needs `wp-login.php` for its own
  steps.

## 2. On the Pi

### PiRO

In `/etc/piro/piro.env`:

```bash
LOGIN_PROXY=on
```

Then `sudo systemctl restart piro`. PiRO now listens on 127.0.0.1 only,
refuses anything that didn't come through the login, and logs members out
after 60 minutes without activity (`IDLE_LOGOUT_MINUTES`).

### oauth2-proxy

Install it from the
[oauth2-proxy releases](https://github.com/oauth2-proxy/oauth2-proxy/releases)
(the `linux-arm64` build for a 64-bit Pi OS). Copy
[`deploy/oauth2-proxy.cfg.example`](../deploy/oauth2-proxy.cfg.example) to
`/etc/oauth2-proxy.cfg` and change the lines marked CHANGE. For
`cookie_secret`, use the output of:

```bash
openssl rand -base64 32 | tr -- '+/' '-_'
```

Run it as a service with `--config=/etc/oauth2-proxy.cfg`.

Members' user names (their WordPress login names) reach PiRO as the
signed-in user. PiRO's log shows them as they connect and leave.

### Caddy

Install Caddy from its Debian repository. `/etc/caddy/Caddyfile`:

```
radio.example.org {
	reverse_proxy 127.0.0.1:4180
}
```

Caddy gets the certificate by itself. It needs ports 80 and 443 forwarded
from the internet to the Pi, and the name `radio.example.org` pointing at
the club's internet address. Forward no other ports: not 8080 (PiRO), not
4180 (oauth2-proxy), not the Icom LAN server's.

## 3. Test

1. Open `https://radio.example.org/` in a private browser window. You
   should land on the club web site's login page.
2. Log in as a member. You should come back to PiRO, connected. PiRO's log
   shows `[ws] <user name> connected`.
3. Log in as a user without `use_piro`. They must not get in. With
   `requires_consent => false`, plugin 2.0.3 doesn't show its "no
   permission" message: it sends the browser back and forth until the
   browser stops with "too many redirects". That is still a refusal.
4. On the Pi, `curl -i http://127.0.0.1:8080/` should answer
   `401 Login required`. From another computer, the Pi's port 8080 should
   not answer at all.
5. For the idle logout, set `IDLE_LOGOUT_MINUTES=2`, restart PiRO, and
   leave a browser alone. After a minute a warning shows; after two, the
   "Logged out" page. Set it back afterwards.

## Logging out

The idle logout ends the PiRO login only. The member is still logged in to
the club web site, so **Log in again** brings them straight back without a
password. To end both, log out of the club web site too.

## If something goes wrong

- **"invalid_scope"** from the club web site: oauth2-proxy asked for a
  scope the client doesn't have. Check
  `scope = "openid profile"` in the oauth2-proxy config.
- **oauth2-proxy says the login has no email:** `piro-login.php` isn't
  running. Check it is in `wp-content/mu-plugins/` (not a folder inside).
- **"redirect_uri mismatch" or similar:** `redirect_uri` in
  `piro-login.php` and `redirect_url` in the oauth2-proxy config must be
  the same, character for character.
- **oauth2-proxy can't start: issuer did not match:** `oidc_issuer_url`
  must be exactly the `issuer` from the openid-configuration page,
  including the final `/`.
- **A member gets "too many redirects":** their role doesn't have
  `use_piro`. Check the role slug in `piro-login.php`.
- **PiRO says "Login required":** see the README's troubleshooting.
