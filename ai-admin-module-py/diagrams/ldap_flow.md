LDAP Authentication Flow

User -> /auth/login
-> LDAP Authenticate (bind/search)
-> If OK or local password OK
-> Issue JWT with token_id
-> Create session record
-> Return token
