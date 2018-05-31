"""Exception classes."""


class PairingError(Exception):
    """Exception to indicate an issue with pairing."""

    UNKNOWN_PIN = "PIN unknown"
    INVALID_PIN = "Invalid PIN"

    def __init__(self, message):
        """Initialize the exception."""
        Exception.__init__(self, message)


class HapError(Exception):
    """Exception to indicate an issue with the HAP protocol."""

    pass


class DatabaseError(Exception):
    """Exception to indicate an issue with the database."""

    pass
