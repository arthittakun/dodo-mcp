/** The single local owner account id (single-owner mode, spec §8.4). */
export const OWNER_ACCOUNT_ID = 'owner';

/**
 * OAuth login identifies one DODO installation. Project access is a separate
 * owner-managed ACL, so consent must never be bound to whichever project is
 * selected while the browser flow happens.
 */
export const INSTALLATION_AUTHORITY_ID = 'dodo-installation';
export const INSTALLATION_AUTHORITY_EPOCH = 'installation-auth-v2';
