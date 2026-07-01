#[derive(Clone, Debug, PartialEq, Eq)]
pub struct User {
	pub id:   String,
	pub name: String,
}

pub fn find_user<'a>(users: &'a [User], id: String) -> Option<&'a User> {
	users.iter().find(|user| user.id == id)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn user_id_round_trips_and_finds_by_reference() {
		let id = UserId::new("u-1");
		assert_eq!(id.as_str(), "u-1");
		let users = vec![User { id: UserId::new("u-1"), name: String::from("Ada") }];
		match find_user(&users, &id) {
			Some(user) => assert_eq!(user.name, "Ada"),
			None => panic!("expected user to be found"),
		}
	}
}
