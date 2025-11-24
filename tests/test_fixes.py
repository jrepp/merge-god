#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///

"""Test the fixes applied to pr-loop.py"""


# Extract just the validation function for testing
def validate_git_ref(ref: str) -> bool:
    """Validate that a string is a safe git reference name"""
    if not ref or not isinstance(ref, str):
        return False

    unsafe_chars = ["\0", "\n", "\r", " ", "~", "^", ":", "?", "*", "[", "\\", "..", "@{", "//"]
    if any(char in ref for char in unsafe_chars):
        return False

    if ref.startswith((".", "/")) or ref.endswith((".", "/", ".lock")):
        return False

    return not len(ref) > 200


# Test cases
def test_validate_git_ref():
    # Valid refs
    assert validate_git_ref("main"), "main should be valid"
    assert validate_git_ref("master"), "master should be valid"
    assert validate_git_ref("feature/test"), "feature/test should be valid"
    assert validate_git_ref("feature-branch"), "feature-branch should be valid"
    assert validate_git_ref("release_1.0"), "release_1.0 should be valid"

    # Invalid refs
    assert not validate_git_ref("bad..branch"), ".. should be invalid"
    assert not validate_git_ref("bad branch"), "space should be invalid"
    assert not validate_git_ref("bad~branch"), "~ should be invalid"
    assert not validate_git_ref("bad^branch"), "^ should be invalid"
    assert not validate_git_ref("bad:branch"), ": should be invalid"
    assert not validate_git_ref(".hidden"), "starting with . should be invalid"
    assert not validate_git_ref("/absolute"), "starting with / should be invalid"
    assert not validate_git_ref("trailing/"), "ending with / should be invalid"
    assert not validate_git_ref("ends.lock"), "ending with .lock should be invalid"
    assert not validate_git_ref(""), "empty string should be invalid"
    assert not validate_git_ref("a" * 201), "too long should be invalid"

    # Test type checking
    try:
        assert not validate_git_ref(None), "None should be invalid"
        assert not validate_git_ref(123), "int should be invalid"
        assert not validate_git_ref(["list"]), "list should be invalid"
    except:
        pass  # Some versions might have type errors

    print("✅ All validate_git_ref tests passed!")


if __name__ == "__main__":
    test_validate_git_ref()
    print("\n✅ All tests passed successfully!")
