<?php
/**
 * Plugin Name: PiRO login
 * Description: Lets members log in to the club's PiRO through the OpenID Connect Server plugin.
 *
 * Copy this file to wp-content/mu-plugins/ on the WordPress site and change
 * the values marked CHANGE. See docs/login-wordpress.md in PiRO.
 */

// The PiRO client. oauth2-proxy uses the same id, secret and redirect URL.
add_filter(
	'oidc_registered_clients',
	function ( $clients ) {
		$clients['piro'] = array(
			'name'             => 'PiRO',
			'secret'           => 'CHANGE: a long random string',
			'redirect_uri'     => 'https://radio.example.org/oauth2/callback', // CHANGE: your PiRO address
			'grant_types'      => array( 'authorization_code' ),
			'scope'            => 'openid profile',
			// Don't ask "Do you want to log in to PiRO?" every week.
			'requires_consent' => false,
		);
		return $clients;
	}
);

// Who may log in: users with the use_piro capability. The plugin's default
// is edit_posts, which members (subscriber-like roles) don't have.
add_filter(
	'oidc_minimal_capability',
	function () {
		return 'use_piro';
	}
);

// Give use_piro to these roles. CHANGE: your member role's slug. Ultimate
// Member shows it under Ultimate Member > User Roles.
add_action(
	'init',
	function () {
		foreach ( array( 'administrator', 'um_member' ) as $role_name ) {
			$role = get_role( $role_name );
			if ( $role && ! $role->has_cap( 'use_piro' ) ) {
				$role->add_cap( 'use_piro' );
			}
		}
	}
);

// oauth2-proxy needs an email address. The plugin doesn't send one.
add_filter(
	'oidc_user_claims',
	function ( $claims, $user ) {
		$claims['email']          = $user->user_email;
		$claims['email_verified'] = true;
		return $claims;
	},
	10,
	2
);
