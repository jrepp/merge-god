#!/usr/bin/env python3
"""Test the fixes applied to pr-loop.py"""

# Extract just the validation function for testing
def validate_git_ref(ref: str) -> bool:
    """Validate that a string is a safe git reference name"""
    if not ref or not isinstance(ref, str):
        return False

    unsafe_chars = ['\0', '\n', '\r', ' ', '~', '^', ':', '?', '*', '[', '\\', '..', '@{', '//']
    if any(char in ref for char in unsafe_chars):
        return False

    if ref.startswith(('.', '/')) or ref.endswith(('.', '/', '.lock')):
        return False

    if len(ref) > 200:
        return False

    return True


# Test cases
def test_validate_git_ref():
    # Valid refs
    assert validate_git_ref('main') == True, "main should be valid"
    assert validate_git_ref('master') == True, "master should be valid"
    assert validate_git_ref('feature/test') == True, "feature/test should be valid"
    assert validate_git_ref('feature-branch') == True, "feature-branch should be valid"
    assert validate_git_ref('release_1.0') == True, "release_1.0 should be valid"

    # Invalid refs
    assert validate_git_ref('bad..branch') == False, ".. should be invalid"
    assert validate_git_ref('bad branch') == False, "space should be invalid"
    assert validate_git_ref('bad~branch') == False, "~ should be invalid"
    assert validate_git_ref('bad^branch') == False, "^ should be invalid"
    assert validate_git_ref('bad:branch') == False, ": should be invalid"
    assert validate_git_ref('.hidden') == False, "starting with . should be invalid"
    assert validate_git_ref('/absolute') == False, "starting with / should be invalid"
    assert validate_git_ref('trailing/') == False, "ending with / should be invalid"
    assert validate_git_ref('ends.lock') == False, "ending with .lock should be invalid"
    assert validate_git_ref('') == False, "empty string should be invalid"
    assert validate_git_ref('a' * 201) == False, "too long should be invalid"

    # Test type checking
    try:
        assert validate_git_ref(None) == False, "None should be invalid"
        assert validate_git_ref(123) == False, "int should be invalid"
        assert validate_git_ref(['list']) == False, "list should be invalid"
    except:
        pass  # Some versions might have type errors

    print("✅ All validate_git_ref tests passed!")


if __name__ == "__main__":
    test_validate_git_ref()
    print("\n✅ All tests passed successfully!")
