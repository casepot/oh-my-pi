use user_core::{User, UserId, find_user};

pub fn sample_users() -> Vec<User> {
	vec![User { id: UserId::new("u-1"), name: String::from("Ada") }, User {
		id:   UserId::new("u-2"),
		name: String::from("Grace"),
	}]
}

pub fn display_name_for(id: &str) -> Option<String> {
	let users = sample_users();
	let id = UserId::new(id);
	find_user(&users, &id).map(|user| user.name.clone())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn finds_display_name() {
		assert_eq!(display_name_for("u-2"), Some(String::from("Grace")));
	}

	#[test]
	fn returns_none_for_missing_user() {
		assert_eq!(display_name_for("missing"), None);
	}
}
