pub fn collect_name_lengths(names: Vec<String>) -> (Vec<usize>, usize) {
	let total = names.len();
	let mut lengths = Vec::with_capacity(total);
	for name in names {
		lengths.push(name.len());
	}
	(lengths, total)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn reports_lengths_and_total_count() {
		let names = vec![String::from("ada"), String::from("grace")];
		assert_eq!(collect_name_lengths(names), (vec![3, 5], 2));
	}
}
